"""모든 API 공통 응답 형식: {"status": "ok", "data": {...}, "message": "..."}

needs_input·infeasible은 정상 응답(HTTP 200)으로 status에 담고, 시스템 오류만 HTTP 5xx + error로 보낸다.
기능별 세부 상태(OPTIMAL 등)는 status를 늘리지 않고 data 안에 넣는다.
"""

from typing import Generic, TypeVar

from pydantic import BaseModel

from app.core.status import ResponseStatus

T = TypeVar("T")


class ApiResponse(BaseModel, Generic[T]):
    status: ResponseStatus
    data: T | None = None
    message: str | None = None


def ok(data: T) -> ApiResponse[T]:
    return ApiResponse(status=ResponseStatus.OK, data=data)


def needs_input(data: T, message: str) -> ApiResponse[T]:
    return ApiResponse(status=ResponseStatus.NEEDS_INPUT, data=data, message=message)


def infeasible(data: T, message: str) -> ApiResponse[T]:
    return ApiResponse(status=ResponseStatus.INFEASIBLE, data=data, message=message)


def error(message: str) -> ApiResponse[None]:
    return ApiResponse(status=ResponseStatus.ERROR, message=message)
