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

@asynccontextmanager
async def lifespan(_: FastAPI):
     # PostgreSQL Connection Pool 초기화
    open_pool()

    try:

        if get_settings().rag_auto_index:

            # 기존 RAG 데이터 자동 적재
            await asyncio.to_thread(
                initialize_quote_rag
            )

            # 추가: KURE-v1 모델 사전 로딩
            log.info("RAG 임베딩 모델 초기화 시작")

            await asyncio.to_thread(
                embedding,
                "임베딩 모델 초기화"
            )

            log.info("RAG 임베딩 모델 초기화 완료")

        yield

    finally:

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