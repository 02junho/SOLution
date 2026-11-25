import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.config import get_settings
from app.rag.quote_search import embedding

from app.agent.router import router as agent_router
from app.core.db import check_database, close_pool, open_pool
from app.core.errors import register_exception_handlers
from app.core.response import ApiResponse, ok
from app.tools.labor.router import router as labor_router
from app.tools.purchase.router import router as purchase_router
from app.tools.simulation.router import router as simulation_router

# 라우터 추가
from app.tools.quote.router import router as quote_router
from app.scripts.index_quote_rag import initialize_quote_rag

log = logging.getLogger("uvicorn.error")

RAG_RETRY_SECONDS = 30
RAG_RETRY_LIMIT = 10


async def prepare_rag() -> bool:
    """견적 RAG 적재와 KURE-v1 모델 사전 로딩. 실패해도 예외를 밖으로 내지 않는다.

    RAG는 견적 정리에만 쓰인다. 여기서 실패했다고 서버가 뜨지 않으면 구매·운영·에이전트 API와
    /health까지 모두 멈추므로, 실패는 로그로 남기고 False를 돌려준다.
    """
    try:
        # 기존 RAG 데이터 자동 적재 (같은 데이터면 다시 넣지 않는다)
        await asyncio.to_thread(initialize_quote_rag)
        log.info("RAG 임베딩 모델 초기화 시작")
        await asyncio.to_thread(embedding, "임베딩 모델 초기화")
        log.info("RAG 임베딩 모델 초기화 완료")
        return True
    except Exception:
        log.exception("RAG 준비 실패: 견적 정리를 뺀 나머지 API는 계속 응답한다")
        return False


async def retry_rag() -> None:
    """처음 준비가 실패했을 때(예: 새 DB에서 테이블이 늦게 생김) 잠시 뒤 몇 번 더 시도한다."""
    for attempt in range(1, RAG_RETRY_LIMIT + 1):
        await asyncio.sleep(RAG_RETRY_SECONDS)
        log.info("RAG 준비 다시 시도 (%d/%d)", attempt, RAG_RETRY_LIMIT)
        if await prepare_rag():
            return
    log.error("RAG 준비를 %d번 다시 시도했지만 실패했다. 서버를 다시 띄워 확인해야 한다.", RAG_RETRY_LIMIT)


@asynccontextmanager
async def lifespan(_: FastAPI):
     # PostgreSQL Connection Pool 초기화
    open_pool()
    retry: asyncio.Task | None = None

    try:

        # 처음 한 번은 끝날 때까지 기다린다(모델을 미리 올려 첫 견적 정리가 느리지 않게).
        if get_settings().rag_auto_index and not await prepare_rag():
            retry = asyncio.create_task(retry_rag())

        yield

    finally:

        if retry is not None:
            retry.cancel()
        close_pool()


app = FastAPI(title="SOLution AI Server", lifespan=lifespan)
register_exception_handlers(app)

# 기능별 라우터는 여기에 붙인다. 주소 규칙: 도구는 /tools/{기능},
# 에이전트는 /agent/interpret(분류·입력 추출·검사·질문)와 /agent/explain(결과 설명)
# 예) from app.tools.labor.router import router as labor_router
#     app.include_router(labor_router, prefix="/tools/labor")
app.include_router(purchase_router, prefix="/tools/purchase")
app.include_router(labor_router, prefix="/tools/labor")
app.include_router(agent_router, prefix="/agent")
app.include_router(simulation_router, prefix="/tools/simulation")


@app.get("/health")
def health() -> ApiResponse[dict]:
    return ok({"ai_server": "ok", "database": check_database()})


# quote 라우터 추가
app.include_router(quote_router)