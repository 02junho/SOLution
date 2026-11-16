"""POST /agent/interpret 검사. 실제 LLM 대신 '가짜 해석기'를 끼워 키 없이도 분기·질문·검증을 확인한다.

여기서 확인하는 것: 명확한 변경→ok, 애매함→needs_input(서버 질문 발급), 허용 안 된 칸→서버가 되물음,
범위 밖→infeasible, 질문답변으로 완성→ok, 필수값 누락→400, LLM 미설정→폼 입력 안내.
"""

import pytest
from fastapi.testclient import TestClient

import app.agent.router as agent_router
import app.main as main
from app.agent.interpreter import LlmUnavailable, get_interpreter
from app.agent.schemas import Change, InterpretDraft, Unresolved

client = TestClient(main.app)

BASE = {
    "store_id": 10,
    "session_id": 100,
    "feature_type": "purchase",
    "event_type": "message",
    "base_version_id": 1001,
    "current_version_id": 1001,
    "content": "예산을 12만원으로 올려줘",
}


@pytest.fixture(autouse=True)
def _no_db_log(monkeypatch):
    """테스트에서는 execution_log를 DB에 쓰지 않는다."""
    monkeypatch.setattr(agent_router, "write_tool_log", lambda **kwargs: None)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    main.app.dependency_overrides.clear()


class FakeInterpreter:
    """해석기 자리에 끼우는 가짜. 정해 둔 결과를 주거나 오류를 낸다."""

    def __init__(self, draft: InterpretDraft | None = None, error: Exception | None = None):
        self._draft = draft
        self._error = error

    def interpret(self, req):
        if self._error is not None:
            raise self._error
        return self._draft


def _use(interpreter):
    main.app.dependency_overrides[get_interpreter] = lambda: interpreter


def test_명확한_변경은_ok_검토후보():
    _use(FakeInterpreter(InterpretDraft(
        intent="change_input",
        changes=[Change(field="budget_krw", label="예산", value=120000, target="budget_krw")],
        reply="예산을 12만원으로 바꿀게요.")))

    r = client.post("/agent/interpret", json=BASE, headers={"X-Request-Key": "k1"})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["data"]["detail_status"] == "INTERPRETED"
    assert body["data"]["interpretation"]["changes"][0]["target"] == "budget_krw"


def test_애매하면_needs_input으로_서버가_질문을_발급한다():
    _use(FakeInterpreter(InterpretDraft(
        intent="ask",
        unresolved=[Unresolved(question_key="milk_quantity_target",
                               text="우유 2L는 지금 재고인가요, 이번에 필요한 총량인가요?",
                               choices=["재고", "총필요량"])])))

    r = client.post("/agent/interpret", json={**BASE, "content": "우유 2L로 바꿔줘"})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "needs_input"
    question = body["data"]["question"]
    assert question["question_key"] == "milk_quantity_target"
    assert question["base_version_id"] == 1001
    assert "재고" in question["choices"]


def test_허용되지_않은_칸이면_서버가_되묻는다():
    # LLM이 target을 못 정하고 unknown으로 주면, 서버가 임의로 고르지 않고 질문으로 되돌린다.
    _use(FakeInterpreter(InterpretDraft(
        intent="change_input",
        changes=[Change(field="milk_quantity", label="우유 수량", value=2000, unit="ml", target="unknown")])))

    r = client.post("/agent/interpret", json={**BASE, "content": "우유 2L로 바꿔줘"})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "needs_input"
    assert body["data"]["question"]["question_key"] == "milk_quantity_target"


def test_실제_발주_요청은_범위_밖이라_infeasible():
    _use(FakeInterpreter(InterpretDraft(intent="unsupported", reply="발주는 이 서비스에서 보내지 않아요.")))

    r = client.post("/agent/interpret", json={**BASE, "content": "거래처에 지금 주문 넣어줘"})

    assert r.status_code == 200
    assert r.json()["status"] == "infeasible"


def test_질문답변으로_변경이_완성되면_ok():
    _use(FakeInterpreter(InterpretDraft(
        intent="change_input",
        changes=[Change(field="milk_usable_inventory", label="우유 재고", value=2000, unit="ml",
                        target="usable_inventory", item_id="milk")],
        reply="우유 재고를 2L로 반영할게요.")))

    r = client.post("/agent/interpret", json={
        "store_id": 10, "session_id": 100, "feature_type": "purchase", "event_type": "question_reply",
        "current_input": {"items": [{"item_id": "milk", "base_unit": "ml"}]},
        "base_version_id": 1001, "question_id": "q:100:1001:milk_quantity_target", "answer": "재고"})

    assert r.status_code == 200
    assert r.json()["data"]["interpretation"]["changes"][0]["target"] == "usable_inventory"


def test_message인데_내용이_없으면_400():
    _use(FakeInterpreter(InterpretDraft()))  # 검증에서 먼저 걸려 해석기까지 가지 않는다.

    r = client.post("/agent/interpret", json={**BASE, "content": "   "})

    assert r.status_code == 400
    assert r.json()["status"] == "error"


def test_LLM이_설정되지_않으면_폼_입력으로_안내한다():
    _use(FakeInterpreter(error=LlmUnavailable("ANTHROPIC_API_KEY 없음")))

    r = client.post("/agent/interpret", json=BASE)

    assert r.status_code == 200
    assert r.json()["status"] == "needs_input"
    assert r.json()["data"]["detail_status"] == "USE_FORM"
    assert r.json()["data"]["missing_fields"][0]["path"] == "form_input"


def test_전체_스냅샷을_반환하고_기존_입력은_보존한다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="budget_krw", label="예산", value=120000, target="budget_krw")], reply="예산 반영")))
    current = {"budget_krw": 100000, "planning_days": 7, "items": [{"item_id": "milk", "base_unit": "ml"}]}
    response = client.post("/agent/interpret", json={**BASE, "current_input": current}).json()
    assert response["data"]["parsed_input"]["input"] == {**current, "budget_krw": 120000}
    assert response["message"] == "예산 반영"
    assert current["budget_krw"] == 100000


def test_품목ID가_없으면_첫번째_품목으로_임의_적용하지_않는다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="milk", label="재고", value=2000, unit="ml", target="usable_inventory")])))
    response = client.post("/agent/interpret", json={**BASE, "current_input": {"items": [
        {"item_id": "milk", "base_unit": "ml"}, {"item_id": "cream", "base_unit": "ml"}]}}).json()
    assert response["status"] == "needs_input"
    assert response["data"]["missing_fields"][0]["path"] == "items"


@pytest.mark.parametrize("value", [None, -1, "모름", 1.5])
def test_잘못된_예산을_스냅샷으로_만들지_않는다(value):
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="budget_krw", label="예산", value=value, target="budget_krw")])))
    response = client.post("/agent/interpret", json=BASE)
    assert response.status_code == 200
    assert response.json()["status"] == "needs_input"
    assert "parsed_input" not in response.json()["data"]


def test_품목의_단위가_맞지_않으면_질문한다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="milk", label="우유 재고", item_id="milk", value=2000, unit="g", target="usable_inventory")])))
    body = client.post("/agent/interpret", json={**BASE, "current_input": {
        "items": [{"item_id": "milk", "base_unit": "ml"}]}}).json()
    assert body["status"] == "needs_input"
    assert body["data"]["missing_fields"][0]["unit"] == "ml"


def test_명시적_잡담은_NO_CHANGE이고_빈_질문은_되묻는다():
    _use(FakeInterpreter(InterpretDraft(intent="smalltalk", reply="안녕하세요")))
    assert client.post("/agent/interpret", json=BASE).json()["data"]["detail_status"] == "NO_CHANGE"
    _use(FakeInterpreter(InterpretDraft(intent="ask", reply="조금 더 알려 주세요")))
    assert client.post("/agent/interpret", json=BASE).json()["status"] == "needs_input"


def test_모델_입력과_해석결과의_개인정보를_가린다():
    class CaptureInterpreter:
        def interpret(self, req):
            assert "010-1234-5678" not in str(req.model_dump())
            assert "홍길동" not in str(req.model_dump())
            return InterpretDraft(intent="unsupported", reply="담당자 홍길동 a@b.com",
                                  evidence=["010-1234-5678"])

    _use(CaptureInterpreter())
    response = client.post("/agent/interpret", json={**BASE, "content": "담당자 홍길동 010-1234-5678"})
    assert all(value not in response.text for value in ["홍길동", "010-1234-5678", "a@b.com"])


def test_전송실패_예외의_원문을_응답에_노출하지_않는다():
    _use(FakeInterpreter(error=LlmUnavailable("private-key private-prompt")))
    response = client.post("/agent/interpret", json=BASE)
    assert response.status_code == 200
    assert "private-key" not in response.text
    assert response.json()["data"]["detail_status"] == "USE_FORM"


def test_같은_조건의_재해석은_NO_CHANGE이다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="budget_krw", label="예산", value=120000, target="budget_krw")])))
    body = client.post("/agent/interpret", json={**BASE, "current_input": {"budget_krw": 120000}}).json()
    assert body["status"] == "ok" and body["data"]["detail_status"] == "NO_CHANGE"


def test_안전재고와_상한은_전체_변경을_적용한뒤_함께_검사한다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="safety", label="안전재고", item_id="milk", value=20, unit="ml", target="safety_stock"),
        Change(field="max", label="상한", item_id="milk", value=30, unit="ml", target="max_end_inventory")])))
    body = client.post("/agent/interpret", json={**BASE, "current_input": {"items": [
        {"item_id": "milk", "base_unit": "ml", "safety_stock": 10, "max_end_inventory": 15}]}}).json()
    assert body["status"] == "ok"
    assert body["data"]["parsed_input"]["input"]["items"][0]["safety_stock"] == 20


def test_같은_칸에_충돌하는_값이_있으면_임의로_마지막값을_고르지_않는다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="budget", label="예산", item_id="milk", value=120000, target="budget_krw"),
        Change(field="budget", label="예산", item_id="cream", value=130000, target="budget_krw")])))
    assert client.post("/agent/interpret", json=BASE).json()["status"] == "needs_input"


def test_질문의_원문맥을_보존하고_질문ID는_Spring에_맡긴다():
    _use(FakeInterpreter(InterpretDraft(intent="ask", unresolved=[Unresolved(question_key="milk", text="재고인가요?")])))
    body = client.post("/agent/interpret", json={**BASE, "content": "우유 2L로 바꿔줘"}).json()
    assert body["data"]["question"]["context"] == "우유 2L로 바꿔줘"
    assert "question_id" not in body["data"]["question"]
    assert body["data"]["missing_fields"][0]["path"]


def test_운영의_지원_범위밖_인원은_임의로_설정하지_않는다():
    _use(FakeInterpreter(InterpretDraft(intent="change_input", changes=[
        Change(field="staff_count", label="인원", value=5, target="staff_count")])))
    body = client.post("/agent/interpret", json={**BASE, "feature_type": "operation",
                                              "current_input": {"staff_count": 2}}).json()
    assert body["status"] == "infeasible" and body["data"]["detail_status"] == "UNSUPPORTED"


def test_질문답변이_모호한_임의_문맥을_담아도_500이_나지_않는다():
    _use(FakeInterpreter(InterpretDraft(intent="ask", unresolved=[Unresolved(question_key="budget", text="예산은요?")])))
    body = client.post("/agent/interpret", json={**BASE, "event_type": "question_reply",
        "question_id": "q-test", "answer": "모름", "question": {"question": "invalid"}})
    assert body.status_code == 200 and body.json()["status"] == "needs_input"


def test_실제_해석기에_키가_없어도_503이_아닌_폼_안내이다(monkeypatch):
    import app.agent.interpreter as interpreter_module
    from app.core.config import Settings

    monkeypatch.setattr(interpreter_module, "get_settings", lambda: Settings(_env_file=None, anthropic_api_key=""))
    response = client.post("/agent/interpret", json=BASE)
    assert response.status_code == 200
    assert response.json()["data"]["detail_status"] == "USE_FORM"
