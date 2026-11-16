"""테스트 대역 없이 실제 Claude와 Spring·FastAPI·DB를 사용하는 유료 smoke test."""

import os
from uuid import uuid4


def _event(backend, session_id, body):
    response = backend.post(f"/api/v1/work-sessions/{session_id}/events",
        headers={"X-Request-Key": str(uuid4())}, json=body)
    assert response.status_code == 200
    return response.json()


def test_interpret_real_claude_updates_budget_and_preserves_input(backend, new_session):
    session_id, snapshot = new_session
    result = _event(backend, session_id, {"event_type": "message",
        "content": "이번 매입 예산을 120000원으로 바꿔줘. 다른 조건은 유지해 줘."})
    assert result["status"] == "ok"
    assert result["data"]["parsed_input"]["input"] == {**snapshot, "budget_krw": 120000}
    assert result["data"]["version_no"] == 2
    context = backend.get(f"/api/v1/work-sessions/{session_id}").json()["data"]
    assert context["current_version_id"] == result["data"]["input_version_id"]
    assert context["input_confirmed"] is False


def test_interpret_real_claude_resolves_question_and_saves_version(backend, new_session):
    session_id, snapshot = new_session
    question = _event(backend, session_id, {"event_type": "message", "content": "우유를 2L로 바꿔줘."})
    assert question["status"] == "needs_input"
    assert question["data"]["question_id"].startswith("q_")
    reply = _event(backend, session_id, {"event_type": "question_reply",
        "question_id": question["data"]["question_id"], "base_version_id": question["data"]["base_version_id"],
        "answer": "현재 사용 가능한 우유 재고를 2000ml로 변경한다는 뜻입니다. 품목 ID는 milk입니다."})
    assert reply["status"] == "ok"
    updated = reply["data"]["parsed_input"]["input"]
    assert updated["items"][0]["usable_inventory"] == 2000
    assert updated["budget_krw"] == snapshot["budget_krw"]
    assert reply["data"]["version_no"] == 2


def test_explain_real_claude_call_succeeds_and_preserves_warnings(backend, ai_server, execution_log):
    session_id = int(os.getenv("LIVE_PURCHASE_SESSION_ID", "1001"))
    version_id = int(os.getenv("LIVE_PURCHASE_VERSION_ID", "100101"))
    response = backend.post(f"/api/v1/purchase/sessions/{session_id}/results", json={"input_version_id": version_id})
    assert response.status_code == 200 and response.json()["status"] == "ok"
    result_id = response.json()["data"]["result_id"]
    detail = backend.get(f"/api/v1/purchase/results/{result_id}").json()["data"]
    request_key = str(uuid4())
    response = ai_server.post("/agent/explain", headers={"X-Request-Key": request_key}, json={
        "store_id": int(os.getenv("LIVE_STORE_ID", "1")), "session_id": session_id, "feature_type": "purchase",
        "result_id": result_id, "result_summary": detail["summary"],
        "focus": "각 안의 총액과 배송 횟수를 아라비아 숫자 및 원·회 단위로 빠짐없이 그대로 넣어 짧게 설명해 주세요."})
    assert response.status_code == 200 and response.json()["status"] == "ok"
    result = response.json()["data"]
    assert result["source"] in {"llm", "template"}
    # 실제 모델 응답 수신을 DB 실행 로그로 증명한다. 미설정·실패·거절·출력 잘림은 성공으로 세지 않는다.
    assert execution_log(request_key)["llm_call_status"] == "success"
    assert result["explanation"]["warnings_echo"] == detail["summary"].get("warnings", [])
    assert len(result["explanation"]["per_choice"]) == len(detail["summary"]["choices"])
