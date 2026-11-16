"""POST /tools/purchase — 구매 최적화 (PuLP + HiGHS).

- 계산에 필요한 칸이 비어 있으면(키 없음·null·빈 목록) needs_input으로 빈 칸을 알려준다. 0으로 채우지 않는다.
  재고 빈칸도 같은 방식이다. 폼·대화로 입력이 덜 쌓인 버전을 계산해도 오류(Spring 502)가 아니라 질문이 된다.
- 값이 틀리면(음수·없는 단위, 없는 거래처·품목, 단위 불일치) 400. Spring이 넣는 store_id 등이 비어도 400.
- 조건을 지키는 안이 없으면 infeasible + 어떤 조건 때문인지.
- 화면은 이 주소를 직접 부르지 않는다. Spring이 AiServerClient로 부른다.
"""

import json
import time
from collections.abc import Callable

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from starlette.concurrency import run_in_threadpool

from app.core.execution_log import LOG_STATUS, write_tool_log
from app.core.request_key import REQUEST_KEY_HEADER, get_request_key
from app.core.response import ApiResponse, needs_input
from app.tools.purchase import missing, service
from app.tools.purchase.optimizer import InputError
from app.tools.purchase.schemas import PurchaseRequest


class _BlankFieldsRoute(APIRoute):
    """요청 검사에서 '빈 칸'만 걸리면 400 대신 needs_input(200)으로 돌려준다. 틀린 값은 그대로 400."""

    def get_route_handler(self) -> Callable:
        handler = super().get_route_handler()

        async def route(request: Request) -> Response:
            started = time.perf_counter()
            try:
                return await handler(request)
            except RequestValidationError as exc:
                try:
                    raw = json.loads(await request.body())
                except ValueError:
                    raise exc from None
                fields = missing.blank_fields(raw, list(exc.errors()))
                if fields is None:
                    raise
                result = needs_input({"detail_status": "NEEDS_INPUT", "missing_fields": fields}, missing.message(fields))
                # 기록은 DB를 동기로 쓰므로 이벤트 루프를 막지 않게 스레드풀에서 한다. 실패해도 응답은 그대로 (write_tool_log가 삼킴).
                await run_in_threadpool(
                    write_tool_log,
                    name="purchase",
                    session_id=raw.get("session_id"),
                    input_version_id=raw.get("input_version_id"),
                    request_key=request.headers.get(REQUEST_KEY_HEADER) or get_request_key(None),
                    status=LOG_STATUS["needs_input"],
                    latency_ms=int((time.perf_counter() - started) * 1000),
                    payload={"response_status": "needs_input", "detail_status": "NEEDS_INPUT", "blank_field_count": len(fields)},
                )
                return JSONResponse(result.model_dump(mode="json"))

        return route


router = APIRouter(route_class=_BlankFieldsRoute)


@router.post("")
def purchase(body: PurchaseRequest, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    started = time.perf_counter()
    try:
        result = service.run(body)
    except InputError as exc:
        _log(body, request_key, "failed", started, {"response_status": "error"})
        raise HTTPException(status_code=400, detail=f"요청 값이 올바르지 않습니다. {exc}") from exc

    data = result.data or {}
    _log(body, request_key, LOG_STATUS[result.status.value], started, {
        "response_status": result.status.value,
        "detail_status": data.get("detail_status"),
        "item_count": len(body.items),
        "supplier_count": len(body.suppliers),
        "quote_count": len(body.quotes),
    })
    return result


def _log(body: PurchaseRequest, request_key: str, status: str, started: float, payload: dict) -> None:
    write_tool_log(
        name="purchase",
        session_id=body.session_id,
        input_version_id=body.input_version_id,
        request_key=request_key,
        status=status,
        latency_ms=int((time.perf_counter() - started) * 1000),
        payload=payload,
    )
