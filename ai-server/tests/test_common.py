import time
from types import SimpleNamespace

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


def test_RAG_준비가_실패해도_서버는_뜨고_다시_시도한다(monkeypatch):
    # 새 DB에서 rag_chunk가 늦게 생기거나 모델 로딩이 실패해도 견적 정리를 뺀 나머지 API와 /health는 응답해야 한다.
    calls = {"rag": 0, "closed": 0}

    def broken_rag():
        calls["rag"] += 1
        raise RuntimeError("rag_chunk 테이블이 아직 없습니다")

    monkeypatch.setattr(main, "open_pool", lambda: None)
    monkeypatch.setattr(main, "close_pool", lambda: calls.__setitem__("closed", calls["closed"] + 1))
    monkeypatch.setattr(main, "check_database", lambda: "ok")
    monkeypatch.setattr(main, "initialize_quote_rag", broken_rag)
    monkeypatch.setattr(main, "RAG_RETRY_SECONDS", 0.01)
    monkeypatch.setattr(main, "RAG_RETRY_LIMIT", 2)
    # get_settings()를 직접 부르면 lru_cache가 이 테스트의 환경으로 채워져 다른 테스트에 남는다.
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(rag_auto_index=True))

    with TestClient(main.app) as client:  # with 블록이어야 lifespan(시작·종료)이 실행된다
        assert client.get("/health").json()["data"] == {"ai_server": "ok", "database": "ok"}
        for _ in range(100):  # 다시 시도는 백그라운드에서 돈다
            if calls["rag"] >= 3:
                break
            time.sleep(0.01)

    assert calls["rag"] == 3  # 처음 1번 + 다시 시도 2번
    assert calls["closed"] == 1


def test_RAG_준비가_성공하면_다시_시도하지_않는다(monkeypatch):
    calls = {"rag": 0, "embed": 0}
    monkeypatch.setattr(main, "open_pool", lambda: None)
    monkeypatch.setattr(main, "close_pool", lambda: None)
    monkeypatch.setattr(main, "initialize_quote_rag", lambda: calls.__setitem__("rag", calls["rag"] + 1))
    monkeypatch.setattr(main, "embedding", lambda _: calls.__setitem__("embed", calls["embed"] + 1))
    monkeypatch.setattr(main, "RAG_RETRY_SECONDS", 0.01)
    # get_settings()를 직접 부르면 lru_cache가 이 테스트의 환경으로 채워져 다른 테스트에 남는다.
    monkeypatch.setattr(main, "get_settings", lambda: SimpleNamespace(rag_auto_index=True))

    with TestClient(main.app):
        time.sleep(0.05)

    assert calls == {"rag": 1, "embed": 1}
