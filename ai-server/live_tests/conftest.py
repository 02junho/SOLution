"""유료 Claude smoke test. 기본 pytest(testpaths=tests)에는 포함하지 않는다.

실행: RUN_LIVE_CLAUDE=1 pytest live_tests -q
Spring·FastAPI 및 시연 매장/구매 입력이 준비된 환경을 사용한다.
API 키는 서버의 .env에서 읽으며 테스트 요청/로그에 싣지 않는다.
"""

import os
from uuid import uuid4

import httpx
import psycopg
from app.core.config import get_settings
import pytest


@pytest.fixture(scope="session", autouse=True)
def require_explicit_live_run():
    if os.environ.get("RUN_LIVE_CLAUDE") != "1":
        pytest.skip("실제 유료 호출은 RUN_LIVE_CLAUDE=1일 때만 실행합니다.")


@pytest.fixture(scope="session")
def backend():
    with httpx.Client(base_url=os.getenv("LIVE_BACKEND_URL", "http://localhost:8080"), timeout=120) as client:
        response = client.get("/api/v1/system/health")
        assert response.status_code == 200
        assert response.json()["data"]["database"] == "ok"
        yield client


@pytest.fixture(scope="session")
def ai_server():
    with httpx.Client(base_url=os.getenv("LIVE_AI_SERVER_URL", "http://localhost:8000"), timeout=120) as client:
        assert client.get("/health").status_code == 200
        yield client


@pytest.fixture
def new_session(backend):
    snapshot = {"budget_krw": 200000, "planning_days": 7, "max_delivery_count": 2,
        "items": [{"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 10000,
                   "usable_inventory": 1000, "safety_stock": 0}]}
    response = backend.post("/api/v1/work-sessions", json={
        "store_id": int(os.getenv("LIVE_STORE_ID", "1")), "feature_type": "purchase", "input_method": "agent",
        "title": "[실제 Claude 검증] 합성 입력"})
    assert response.status_code == 200 and response.json()["status"] == "ok"
    session_id = response.json()["data"]["session_id"]
    response = backend.post(f"/api/v1/work-sessions/{session_id}/events", headers={"X-Request-Key": str(uuid4())},
        json={"event_type": "form", "form_input": snapshot})
    assert response.status_code == 200 and response.json()["status"] == "ok"
    return session_id, snapshot


@pytest.fixture
def execution_log():
    """현재 환경의 DB에서 요청키로 모델 호출 상태만 확인한다. 키·원문은 조회하지 않는다."""
    def read(request_key):
        with psycopg.connect(get_settings().database_conninfo) as connection:
            row = connection.execute(
                "SELECT payload_json FROM execution_log WHERE request_key = %s AND name = 'agent.explain' "
                "ORDER BY log_id DESC LIMIT 1", (request_key,)).fetchone()
        assert row is not None
        return row[0]
    return read
