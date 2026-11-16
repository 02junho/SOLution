"""POST /agent/explain 검사. 실제 LLM 대신 가짜 설명기를 끼워 키 없이 확인한다.

확인: 요약으로 템플릿 설명 생성, 요약 없으면 400, 그리고 LLM이 '없던 숫자'를 만들면 버리고 템플릿으로 떨어지는지(H07).
"""

import types

import pytest
from fastapi.testclient import TestClient

import app.agent.router as agent_router
import app.main as main
from app.agent import explain_service
from app.agent.explain_service import get_explainer
from app.agent.schemas import ExplainRequest

client = TestClient(main.app)

SUMMARY = {
    "detail_status": "OPTIMAL",
    "choices": [
        {"choice_key": "purchase_1", "label": "총비용 최소", "total_krw": 120400, "delivery_count": 2,
         "warning_ids": ["VAT_UNKNOWN"]},
        {"choice_key": "purchase_2", "label": "배송 1회", "total_krw": 138000, "delivery_count": 1,
         "warning_ids": []},
    ],
    "baseline": {"label": "단위단가순 담기(비교용)", "total_krw": 135800},
    "warnings": [{"warning_id": "VAT_UNKNOWN", "requires_ack": True, "message": "일부 견적은 부가세 포함 여부를 몰라요."}],
    "assumptions": ["거래처 1곳 = 배송 1회"],
}
REQ = {"store_id": 10, "session_id": 100, "feature_type": "purchase", "result_id": 2001, "result_summary": SUMMARY}


@pytest.fixture(autouse=True)
def _no_db_log(monkeypatch):
    monkeypatch.setattr(agent_router, "write_tool_log", lambda **kwargs: None)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    main.app.dependency_overrides.clear()


class TemplateFake:
    """항상 템플릿 설명을 돌려주는 가짜(키 없는 환경과 같은 동작)."""

    def explain(self, req):
        return explain_service.build_template(req)


def _use(explainer):
    main.app.dependency_overrides[get_explainer] = lambda: explainer


def test_결과요약으로_템플릿_설명을_돌려준다():
    _use(TemplateFake())

    r = client.post("/agent/explain", json=REQ, headers={"X-Request-Key": "k1"})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["data"]["source"] == "template"
    assert "120,400" in body["data"]["explanation"]["headline"]  # 받은 숫자 그대로
    assert len(body["data"]["explanation"]["per_choice"]) == 2
    assert len(body["data"]["explanation"]["warnings_echo"]) == 1  # 경고는 그대로 전달


def test_result_summary가_비면_400():
    _use(TemplateFake())

    r = client.post("/agent/explain", json={**REQ, "result_summary": {}})

    assert r.status_code == 400
    assert r.json()["status"] == "error"


def test_LLM이_없던_숫자를_만들면_버리고_템플릿을_쓴다(monkeypatch):
    monkeypatch.setattr(explain_service, "get_settings",
                        lambda: types.SimpleNamespace(anthropic_api_key="x", anthropic_model="m"))
    explainer = explain_service.LlmExplainer()
    req = ExplainRequest(**REQ)
    template = explain_service.build_template(req)

    # 요약에 없던 숫자(999999)를 지어내면 → None(= 템플릿으로 떨어짐)
    monkeypatch.setattr(explainer, "_call",
                        lambda settings, r: '{"headline": "안 1이 999999원입니다", "per_choice": []}')
    assert explainer._refine(req, template) is None


def test_LLM이_받은_숫자만_쓰면_다듬은_설명을_쓴다(monkeypatch):
    monkeypatch.setattr(explain_service, "get_settings",
                        lambda: types.SimpleNamespace(anthropic_api_key="x", anthropic_model="m"))
    explainer = explain_service.LlmExplainer()
    req = ExplainRequest(**REQ)
    template = explain_service.build_template(req)

    monkeypatch.setattr(explainer, "_call", lambda settings, r: (
        '{"headline": "총비용 최소가 120,400원으로 가장 쌉니다",'
        ' "per_choice": [{"choice_key": "purchase_1", "text": "배송 2회 120,400원"}],'
        ' "caveats": ["부가세 포함 여부를 확인하면 더 정확해져요."]}'))

    out = explainer._refine(req, template)
    assert out is not None
    assert out["source"] == "llm"
    assert out["explanation"]["warnings_echo"] == template["explanation"]["warnings_echo"]


def _model_output(monkeypatch, payload, request=None):
    import json

    monkeypatch.setattr(explain_service, "get_settings", lambda: types.SimpleNamespace(anthropic_api_key="test", anthropic_model="test"))
    explainer = explain_service.LlmExplainer()
    monkeypatch.setattr(explainer, "_call", lambda *_: json.dumps(payload))
    return explainer.explain(ExplainRequest(**(request or REQ)))


@pytest.mark.parametrize("payload", [
    {"headline": "120,400원", "per_choice": ["invalid"]},
    {"headline": 120400, "per_choice": []},
    {"headline": "결과", "per_choice": None},
    {"headline": "결과", "caveats": "not-a-list"},
    {"headline": "결과", "caveats": [12]},
    {"headline": "-120400원", "per_choice": []},
    {"headline": "120400.2원", "per_choice": []},
    {"headline": "결과", "caveats": ["추가 절감액은 999999원"]},
    {"headline": "결과", "caveats": ["2% 절감됩니다"]},
    {"headline": "결과", "per_choice": [{"choice_key": "purchase_1", "text": "138000원"}]},
    {"headline": "결과", "per_choice": [{"choice_key": "purchase_2", "text": "배송 2회"}]},
    {"headline": "결과", "per_choice": [{"choice_key": "unknown", "text": "120400원"}]},
    {"headline": "결과", "per_choice": [{"choice_key": "purchase_1", "text": "120400원"},
                                         {"choice_key": "purchase_1", "text": "120400원"}]},
    {"headline": "지금 결제하세요", "per_choice": []},
    {"headline": "효과를 보장합니다", "per_choice": []},
    {"headline": "결과", "caveats": ["백만원 절감됩니다"]},
    {"headline": "결과", "per_choice": [{"choice_key": "purchase_1", "text": "배송 열 번입니다"}]},
])
def test_잘못된_구조_수치_단위_권유는_템플릿으로_대체한다(monkeypatch, payload):
    assert _model_output(monkeypatch, payload)["source"] == "template"


@pytest.mark.parametrize("summary", [
    {"choices": "invalid"}, {"choices": ["invalid"]},
    {"choices": [{"choice_key": "a", "total_krw": -1}]},
    {"choices": [{"choice_key": "a", "total_krw": 1.5}]},
    {"choices": [{"choice_key": "a", "total_krw": True}]},
    {"choices": [{"choice_key": "a", "delivery_count": "2"}]},
    {"choices": [{"choice_key": "a"}, {"choice_key": "a"}]},
    {"warnings": "invalid"}, {"warnings": [{"requires_ack": "yes"}]},
    {"assumptions": "invalid"},
])
def test_요약_형식이_잘못되면_LLM_호출전에_400(summary):
    class MustNotCall:
        def explain(self, _):
            raise AssertionError("요청 검증이 먼저여야 합니다")

    _use(MustNotCall())
    response = client.post("/agent/explain", json={**REQ, "result_summary": summary})
    assert response.status_code == 400
    assert response.json()["status"] == "error"


def test_일부_안만_다듬어도_나머지_안과_핵심_비교와_경고를_유지한다(monkeypatch):
    out = _model_output(monkeypatch, {"headline": "안의 금액은 138000원입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": "배송 2회 120400원"}]})
    template = explain_service.build_template(ExplainRequest(**REQ))
    assert out["source"] == "llm"
    assert out["explanation"]["headline"] == template["explanation"]["headline"]
    assert len(out["explanation"]["per_choice"]) == 2
    assert out["explanation"]["warnings_echo"] == SUMMARY["warnings"]
    assert out["explanation"]["warnings_echo"][0]["requires_ack"] is True


def test_운영_설명은_LLM이_빼도_모의조건_표시를_유지한다(monkeypatch):
    request = {**REQ, "feature_type": "operation"}
    out = _model_output(monkeypatch, {"headline": "계산 결과입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": "120400원 배송 2회"}]}, request)
    assert "모의 조건" in out["explanation"]["headline"]
    assert any("모의 조건" in caveat for caveat in out["explanation"]["caveats"])


def test_숫자가_없는_요약은_없는_값을_만들지_않는다():
    _use(TemplateFake())
    out = client.post("/agent/explain", json={**REQ, "result_summary": {"detail_status": "INFEASIBLE"}}).json()
    assert out["status"] == "ok"
    assert out["data"]["explanation"]["per_choice"] == []
    assert "없는 수치" in out["message"]


def test_금액과_배송횟수는_반올림하거나_잘라내지_않는다():
    req = ExplainRequest(**{**REQ, "result_summary": {"choices": [
        {"choice_key": "a", "total_krw": 1204000000000000000000000000001, "delivery_count": 1234567}]}})
    template = explain_service.build_template(req)
    assert "1,204,000,000,000,000,000,000,000,000,001원" in template["explanation"]["headline"]
    assert "1234567회" in template["explanation"]["per_choice"][0]["text"]
    assert explain_service._numbers("1204000000000000000000000000001") != explain_service._numbers("1204000000000000000000000000002")


def test_LLM_키가_없으면_실제_설명기가_템플릿을_반환한다(monkeypatch):
    monkeypatch.setattr(explain_service, "get_settings", lambda: types.SimpleNamespace(anthropic_api_key=""))
    response = client.post("/agent/explain", json=REQ)
    assert response.status_code == 200
    assert response.json()["data"]["source"] == "template"


def test_SDK_실패_거절_잘못된_JSON은_템플릿으로_대체한다(monkeypatch):
    import langchain_anthropic

    monkeypatch.setattr(explain_service, "get_settings", lambda: types.SimpleNamespace(anthropic_api_key="test", anthropic_model="configured-model"))
    for result in [RuntimeError("private-key private-input"),
                   types.SimpleNamespace(content='{"headline":"거절"}', response_metadata={"stop_reason": "refusal"}),
                   types.SimpleNamespace(content="bad JSON", response_metadata={})]:
        def invoke(_, result=result):
            if isinstance(result, Exception):
                raise result
            return result

        monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", lambda **_: types.SimpleNamespace(invoke=invoke))
        response = client.post("/agent/explain", json=REQ)
        assert response.status_code == 200
        assert response.json()["data"]["source"] == "template"
        assert "private-key" not in response.text


def test_SDK_옵션과_개인정보_가림(monkeypatch):
    import copy
    import langchain_anthropic

    captured = {}

    class Model:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def invoke(self, messages):
            captured["messages"] = str(messages)
            return types.SimpleNamespace(content=[{"type": "text", "text": "{}"}], response_metadata={})

    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", Model)
    req = copy.deepcopy(REQ)
    req["focus"] = "담당자 홍길동 010-1234-5678 example@private.test"
    settings = types.SimpleNamespace(anthropic_api_key="local-test-only", anthropic_model="configured-model")
    explain_service.LlmExplainer()._call(settings, ExplainRequest(**req))
    assert captured["model"] == "configured-model" and captured["max_retries"] == 0
    assert not {"temperature", "top_p", "thinking", "tool_choice"}.intersection(captured)
    assert all(value not in captured["messages"] for value in ["홍길동", "010-1234-5678", "example@private.test"])


def test_설명_실행로그는_결과ID와_llm종류를_기록하고_원문은_기록하지_않는다(monkeypatch):
    logs = []
    monkeypatch.setattr(agent_router, "write_tool_log", lambda **kwargs: logs.append(kwargs))
    _use(TemplateFake())
    client.post("/agent/explain", json=REQ, headers={"X-Request-Key": "explain-log"})
    assert logs[0]["log_type"] == "llm"
    assert logs[0]["result_id"] == 2001 and logs[0]["request_key"] == "explain-log"
    assert set(logs[0]["payload"]) == {"response_status", "detail_status", "source"}



def test_지수나_숫자열이_비정상적으로_커도_숫자검사가_메모리를_과도하게_쓰지_않는다():
    assert explain_service._numbers("1e999999999") == {"INVALID_NUMBER"}
    assert explain_service._numbers("1" * 200) == {"INVALID_NUMBER"}


def test_잘못된_숫자형식은_입력에도_있더라도_허용하지_않는다():
    assert not explain_service._safe_text("12,34", {"INVALID_NUMBER"})


@pytest.mark.parametrize("caveat,keep", [
    ("purchase_1은 138,000원입니다.", False),
    ("purchase_1은 120,400원입니다.", True),
    ("purchase_2은 138,000원입니다.", True),
    ("총액은 120,400원입니다.", False),
    ("purchase_1과 purchase_2의 총액은 120,400원입니다.", False),
    ("purchase_1과purchase_2의 총액은 120,400원입니다.", False),
    ("purchase_10은 120,400원입니다.", False),
])
def test_caveat_금액은_명시된_단일_안의_금액과_일치할때만_남긴다(monkeypatch, caveat, keep):
    out = _model_output(monkeypatch, {"headline": "결과입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": "배송 2회 120,400원입니다."}],
        "caveats": [caveat, "부가세 포함 여부를 확인해 주세요."]})
    assert out["source"] == "llm"
    assert (caveat in out["explanation"]["caveats"]) is keep
    assert "부가세 포함 여부를 확인해 주세요." in out["explanation"]["caveats"]


@pytest.mark.parametrize("text", ["120400 2", "120400원 배송 2", "배송 2회 비용 120400"])
def test_필수_금액과_배송횟수의_단위가_없으면_템플릿_문장을_유지한다(monkeypatch, text):
    out = _model_output(monkeypatch, {"headline": "결과입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": text}]})
    template = explain_service.build_template(ExplainRequest(**REQ))
    assert out["explanation"]["per_choice"][0] == template["explanation"]["per_choice"][0]


def test_필수_사실과_단위를_모두_포함하면_모델_문장을_채택한다(monkeypatch):
    text = "배송 2회이며 총액은 120,400원입니다."
    out = _model_output(monkeypatch, {"headline": "결과입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": text}]})
    assert out["source"] == "llm"
    assert out["explanation"]["per_choice"][0]["text"] == text


@pytest.mark.parametrize("allowed", [False, True])
def test_퍼센트_표기도_해당_안의_비율과_비교한다(monkeypatch, allowed):
    import copy

    request = copy.deepcopy(REQ)
    if allowed:
        request["result_summary"]["choices"][0]["saving_pct"] = 2
    text = "배송 2회 120400원이며 비율은 2퍼센트입니다."
    out = _model_output(monkeypatch, {"headline": "결과입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": text}]}, request)
    assert (out["source"] == "llm") is allowed


def test_중첩된_키의_개인정보를_SDK_전달전에_가린다(monkeypatch):
    import copy
    import langchain_anthropic

    captured = {}

    class Model:
        def __init__(self, **_):
            pass

        def invoke(self, messages):
            captured["messages"] = str(messages)
            return types.SimpleNamespace(content="{}", response_metadata={})

    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", Model)
    request = copy.deepcopy(REQ)
    request["result_summary"]["metadata"] = {
        "example@private.test": [{"010-1234-5678": {"담당자 홍길동": "연락처"}}]}
    settings = types.SimpleNamespace(anthropic_api_key="local-test-only", anthropic_model="configured-model")
    explain_service.LlmExplainer()._call(settings, ExplainRequest(**request))
    assert all(value not in captured["messages"] for value in ["example@private.test", "010-1234-5678", "홍길동"])


def test_마스킹으로_같아진_키도_원문_노출없이_항목을_보존한다():
    from app.agent.privacy import sanitize

    result = sanitize({"first@private.test": "first", "second@private.test": "second"})
    assert len(result) == 2 and set(result.values()) == {"first", "second"}
    assert all("private.test" not in key for key in result)



def test_단위가_빠진_문장도_같은_안의_중복_문장을_허용하지_않는다(monkeypatch):
    out = _model_output(monkeypatch, {"headline": "결과입니다", "per_choice": [
        {"choice_key": "purchase_1", "text": "120400 2"},
        {"choice_key": "purchase_1", "text": "배송 2회 120400원"}]})
    assert out["source"] == "template"
