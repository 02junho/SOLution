"""예외를 공통 응답 형식으로 바꾼다. 정보 부족·답 없음은 예외가 아니라 각 도구가 needs_input/infeasible로 돌려준다."""

import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.response import error

logger = logging.getLogger(__name__)


def _json(status_code: int, message: str) -> JSONResponse:
    return JSONResponse(status_code=status_code, content=error(message).model_dump(mode="json"))


def register_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(RequestValidationError)
    async def handle_validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        fields = ", ".join(
            ".".join(str(part) for part in err["loc"] if part != "body") + ": " + err["msg"]
            for err in exc.errors()
        )
        return _json(400, f"요청 값이 올바르지 않습니다. {fields}")

    @app.exception_handler(StarletteHTTPException)
    async def handle_http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        message = "없는 주소입니다." if exc.status_code == 404 else str(exc.detail)
        return _json(exc.status_code, message)

    @app.exception_handler(Exception)
    async def handle_unexpected(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("처리하지 못한 오류", exc_info=exc)
        return _json(500, "서버 오류가 발생했습니다.")
