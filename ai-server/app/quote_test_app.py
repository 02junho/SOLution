"""견적 모듈만 검증할 때 사용하는 ASGI 진입점."""
from fastapi import FastAPI

from app.core.errors import register_exception_handlers
from app.tools.quote.router import router

app = FastAPI(title="SOLution Quote Test")
register_exception_handlers(app)
app.include_router(router)
