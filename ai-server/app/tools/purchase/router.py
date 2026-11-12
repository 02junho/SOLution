"""POST /tools/purchase — 구매 최적화 (지금은 11.15 더미 연결용).

- 재고가 빈칸(null)인 품목이 있으면 needs_input으로 빠진 칸을 알려준다. 0으로 채우지 않는다.
- 그 밖에는 dummy.py의 고정 결과를 돌려준다. 실제 PuLP 계산은 다음 단계에서 이 자리를 바꾼다.
- 화면은 이 주소를 직접 부르지 않는다. Spring이 AiServerClient로 부른다.
"""

import copy

from fastapi import APIRouter, Depends

from app.core.request_key import get_request_key
from app.core.response import ApiResponse, needs_input, ok
from app.tools.purchase.dummy import DUMMY_OK_DATA
from app.tools.purchase.schemas import PurchaseRequest

router = APIRouter()


def _missing_inventory(body: PurchaseRequest) -> list[dict]:
    return [
        {
            "path": f"items[{i}].usable_inventory",
            "item_id": item.item_id,
            "label": f"{item.item_name} 재고",
            "unit": item.base_unit,
        }
        for i, item in enumerate(body.items)
        if item.usable_inventory is None
    ]


@router.post("")
def purchase(body: PurchaseRequest, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    missing = _missing_inventory(body)
    if missing:
        labels = ", ".join(m["label"] for m in missing)
        return needs_input(
            {"detail_status": "NEEDS_INPUT", "missing_fields": missing},
            f"{labels}가 지금 얼마나 있나요?",
        )
    return ok(copy.deepcopy(DUMMY_OK_DATA))
