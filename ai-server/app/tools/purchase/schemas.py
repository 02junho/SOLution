"""POST /tools/purchase 요청 모양. 노션 API 명세서 "구매 최적화"와 같은 필드다.

모르는 값은 null로 받는다. 0으로 바꾸지 않는다(계산에 꼭 필요한 값이 null이면 needs_input).
음수·잘못된 형식은 Pydantic 검사에서 걸러져 400으로 나간다.
"""

from typing import Literal

from pydantic import BaseModel, Field

BaseUnit = Literal["g", "ml", "ea"]


class PurchaseItem(BaseModel):
    item_id: str = Field(min_length=1)
    item_name: str = Field(min_length=1)
    base_unit: BaseUnit
    gross_need: float = Field(ge=0, description="기간 동안 필요한 총량 (견적 정리 결과, 재고 차감 전)")
    # 키가 빠져도 null과 같게 본다. 400(Spring에서는 502)이 아니라 사장님께 재고를 묻는다.
    usable_inventory: float | None = Field(default=None, ge=0, description="지금 쓸 수 있는 재고. 모르면 null 또는 생략")
    safety_stock: float = Field(ge=0, description="기간 끝에 남겨 둘 양. 없으면 0")
    storage_capacity: float | None = Field(default=None, gt=0, description="보관 한도. null이면 제한 없음")


class PurchaseSupplier(BaseModel):
    supplier_id: str = Field(min_length=1)
    supplier_name: str = Field(min_length=1)
    minimum_order_krw: int = Field(ge=0)
    delivery_fee_krw: int = Field(ge=0)
    free_delivery_min_krw: int | None = Field(default=None, ge=0)


class PurchaseQuote(BaseModel):
    supplier_id: str = Field(min_length=1)
    item_id: str = Field(min_length=1)
    pack_size: float = Field(gt=0)
    pack_unit: BaseUnit
    pack_price_krw: int = Field(ge=0)
    vat_included: bool | None


class PurchaseRequest(BaseModel):
    store_id: int
    session_id: int
    input_version_id: int
    planning_days: int = Field(gt=0)
    budget_krw: int = Field(ge=0)
    max_delivery_count: int = Field(ge=1)
    items: list[PurchaseItem] = Field(min_length=1)
    suppliers: list[PurchaseSupplier] = Field(min_length=1)
    quotes: list[PurchaseQuote] = Field(min_length=1)
