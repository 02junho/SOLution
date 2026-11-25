from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from pydantic import BaseModel

import app.main as main
from app.core.errors import register_exception_handlers
from app.core.request_key import get_request_key
from app.core.response import needs_input


def test_health_공통_응답_형식(monkeypatch):
    monkeypatch.setattr(main, "check_database", lambda: "unavailable")
    response = TestClient(main.app).get("/health")

    assert response.status_code == 200
    assert response.json() == {
        "status": "ok",
        "data": {"ai_server": "ok", "database": "unavailable"},
        "message": None,
    }


def test_없는_주소는_404_error():
    response = TestClient(main.app).get("/nothing")

    assert response.status_code == 404
    assert response.json()["status"] == "error"


class LaborRequest(BaseModel):
    hours: int


def _sample_app() -> FastAPI:
    sample = FastAPI()
    register_exception_handlers(sample)

    @sample.post("/tools/sample")
    def sample_tool(body: LaborRequest, request_key: str = Depends(get_request_key)):
        return needs_input({"request_key": request_key, "missing_fields": ["wage_krw"]}, "시급을 알려주세요")

    return sample


def test_정보_부족은_200_needs_input이고_요청키를_받는다():
    response = TestClient(_sample_app()).post(
        "/tools/sample", json={"hours": 2}, headers={"X-Request-Key": "key-1"}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "needs_input"
    assert body["data"]["request_key"] == "key-1"


def test_잘못된_요청은_400_error():
    response = TestClient(_sample_app()).post("/tools/sample", json={"hours": "두 시간"})

    assert response.status_code == 400
    assert response.json()["status"] == "error"
    assert "hours" in response.json()["message"]


def test_LLM_모델_기본값은_팀_공통_모델(monkeypatch):
    from app.core.config import Settings

    monkeypatch.delenv("ANTHROPIC_MODEL", raising=False)
    assert Settings(_env_file=None).anthropic_model == "claude-sonnet-5-5"
