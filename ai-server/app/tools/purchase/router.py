"""POST /tools/purchase — 구매 최적화 (PuLP + HiGHS).

- 재고가 빈칸(null 또는 생략)인 품목이 있으면 needs_input으로 빠진 칸을 알려준다. 0으로 채우지 않는다.
- 요청 안의 값끼리 맞지 않으면(없는 거래처·품목, 단위 불일치) 400.
- 조건을 지키는 안이 없으면 infeasible + 어떤 조건 때문인지.
- 화면은 이 주소를 직접 부르지 않는다. Spring이 AiServerClient로 부른다.
"""

import time

from fastapi import APIRouter, Depends, HTTPException

from app.core.execution_log import LOG_STATUS, write_tool_log
from app.core.request_key import get_request_key
from app.core.response import ApiResponse
from app.tools.purchase import service
from app.tools.purchase.optimizer import InputError
from app.tools.purchase.schemas import PurchaseRequest

router = APIRouter()


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
