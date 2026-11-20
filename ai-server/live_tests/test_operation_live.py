"""운영 대화를 실제 Claude로 확인하는 유료 smoke test. 기본 pytest(testpaths=tests)에는 포함하지 않는다.

실행: RUN_LIVE_CLAUDE=1 pytest live_tests/test_operation_live.py -q
Spring·FastAPI·DB가 떠 있어야 한다(docker compose up). 키워드 규칙 없이 LLM이 방금 물은 칸의 답으로 읽는지 본다.
"""

import os
from uuid import uuid4

import pytest


def _event(backend, session_id, content):
    response = backend.post(f"/api/v1/work-sessions/{session_id}/events",
        headers={"X-Request-Key": str(uuid4())}, json={"event_type": "message", "content": content})
    assert response.status_code == 200
    return response.json()


def _form(body):
    return ((body.get("data") or {}).get("parsed_input") or {}).get("input", {}).get("operation_form")


@pytest.fixture
def operation_session(backend):
    response = backend.post("/api/v1/work-sessions", json={
        "store_id": int(os.getenv("LIVE_STORE_ID", "1")), "feature_type": "operation", "input_method": "agent",
        "title": "[실제 Claude 검증] 운영 대화"})
    assert response.status_code == 200 and response.json()["status"] == "ok"
    return response.json()["data"]["session_id"]


def test_한_번에_말한_값과_짧은_답을_LLM이_읽고_비교해줘로_계산을_시작한다(backend, operation_session):
    one = _event(backend, operation_session, "하루 200건 정도고 사장님은 매장에 안 나와요")
    # 저장되면 Spring이 말풍선을 "입력을 저장했어요"로 바꾸고, 다음 질문(시급)은 화면의 입력 확인 카드가 보여 준다.
    assert _form(one) == {"daily_orders": 200, "is_owner_working": False}

    two = _event(backend, operation_session, "최저")
    form = _form(two)
    assert form["hourly_wage_krw"] >= 10320 and form["daily_orders"] == 200

    hold = _event(backend, operation_session, "아직 돌리지 마")
    assert (hold.get("data") or {}).get("action") != "run_operation"

    start = _event(backend, operation_session, "비교해줘")
    assert start["data"].get("action") == "run_operation"


def test_사장님_근무_질문에_직원과_같이_한다는_답을_사장님_근무로_읽는다(backend, operation_session):
    _event(backend, operation_session, "하루 150건")
    answer = _event(backend, operation_session, "네, 직원 둘이랑 같이 해요")
    assert _form(answer)["is_owner_working"] is True


def test_직원_2명은_인원_변경이_아니라_사장님이_안_나오는_것으로_읽는다(backend, operation_session):
    # 화면의 '일하는 사람' 표기(직원 2명)를 그대로 말한 경우
    _event(backend, operation_session, "하루 150건, 사장님도 일해요, 시급 11000원")
    answer = _event(backend, operation_session, "직원 2명")
    assert _form(answer)["is_owner_working"] is False


def test_최저시급을_거절하고_금액을_말하면_그_금액을_쓴다(backend, operation_session):
    _event(backend, operation_session, "하루 150건, 사장님도 일해요")
    answer = _event(backend, operation_session, "최저 말고 11000원")
    assert _form(answer)["hourly_wage_krw"] == 11000

# ---- 시연·부스에서 사장님이 할 만한 말 (11.20 추가) ----

def _complete(backend, session_id):
    """필수 값을 한 번에 채운다(시연 문장)."""
    body = _event(backend, session_id, "하루 150건 정도, 사장님도 같이 일하고 시급은 11,000원이에요")
    assert _form(body) == {"daily_orders": 150, "is_owner_working": True, "hourly_wage_krw": 11000}
    return body


def test_시연_문장_한_번에_채우고_줄임말로_계산을_시작한다(backend, operation_session):
    _complete(backend, operation_session)
    start = _event(backend, operation_session, "ㄱㄱ")
    assert (start.get("data") or {}).get("action") == "run_operation"


def test_세_안을_묻는_질문은_계산을_시작하지_않는다(backend, operation_session):
    _complete(backend, operation_session)
    answer = _event(backend, operation_session, "서로 돕기랑 한 명 추가 중에 뭐가 나아?")
    assert (answer.get("data") or {}).get("action") != "run_operation"
    assert _form(answer) is None  # 값도 바꾸지 않는다


def test_상대적인_말과_라스트오더를_지금_값에_맞춰_바꾼다(backend, operation_session):
    _complete(backend, operation_session)
    more = _event(backend, operation_session, "주문 50건 늘려줘")
    assert _form(more)["daily_orders"] == 200
    close = _event(backend, operation_session, "라스트오더 6시 반으로")
    assert _form(close)["last_order_time"] == "18:30"


def test_화면_표기_사장님_더하기_직원_1명은_사장님_근무로_읽는다(backend, operation_session):
    _event(backend, operation_session, "하루 150건, 사장님은 안 나와요, 시급 11000원")
    answer = _event(backend, operation_session, "사장님 + 직원 1명으로 바꿔줘")
    assert _form(answer)["is_owner_working"] is True


def test_사장님_근무와_못_바꾸는_인원이_섞여도_사장님_근무는_반영한다(backend, operation_session):
    _event(backend, operation_session, "하루 150건")
    answer = _event(backend, operation_session, "사장님은 안 나오고 직원 셋이서 해요")
    assert _form(answer)["is_owner_working"] is False


def test_바쁜_시간을_바꾸려_하면_값은_그대로_두고_안내한다(backend, operation_session):
    _complete(backend, operation_session)
    answer = _event(backend, operation_session, "바쁜 시간을 12시부터로 바꿔줘")
    assert answer["status"] == "infeasible"
    assert "11" in answer["message"]


def test_최저시급보다_낮은_시급은_저장하지_않고_다시_묻는다(backend, operation_session):
    _event(backend, operation_session, "하루 150건, 사장님도 일해요")
    answer = _event(backend, operation_session, "시급 9000원")
    assert answer["status"] == "needs_input"
    assert _form(answer) is None or _form(answer).get("hourly_wage_krw") is None
