from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.core.db import check_database, close_pool, open_pool
from app.core.errors import register_exception_handlers
from app.core.response import ApiResponse, ok


@asynccontextmanager
async def lifespan(_: FastAPI):
    open_pool()
    yield
    close_pool()


app = FastAPI(title="SOLution AI Server", lifespan=lifespan)
register_exception_handlers(app)

# 기능별 라우터는 여기에 붙인다. 주소 규칙: 도구는 /tools/{기능},
# 에이전트는 /agent/interpret(분류·입력 추출·검사·질문)와 /agent/explain(결과 설명)
# 예) from app.tools.labor.router import router as labor_router
#     app.include_router(labor_router, prefix="/tools/labor")


@app.get("/health")
def health() -> ApiResponse[dict]:
    return ok({"ai_server": "ok", "database": check_database()})
