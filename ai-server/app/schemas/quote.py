from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, StringConstraints

Text = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
Unit = Literal["g", "ml", "개"]
DocType = Literal["item_alias", "labor_rule", "assumption", "data_source"]

class DTO(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class ParseInput(DTO):
    text: Annotated[Text, Field(max_length=15000)]
    supplier_name: Text | None = None


class Delivery(DTO):
    source_text: Text
    supplier_name: Text | None = None
    fee_amount: StrictInt | None = None
    free_shipping_minimum: StrictInt | None = None
    # 거래처 최소 주문 금액. 구매 최적화의 minimum_order_krw로 이어진다. 원문에 없으면 null.
    minimum_order_amount: StrictInt | None = None


class Quote(DTO):
    source_text: Text
    supplier_name: Text | None = None
    raw_item_name: Text
    specification_text: Text | None = None
    quantity_per_unit: Decimal | None = None
    quantity_unit: Literal["kg", "g", "L", "ml", "개"] | None = None
    units_per_pack: StrictInt | None = None
    order_unit: Text | None = None
    price: StrictInt | None = None
    price_basis: Literal["per_pack", "per_unit"] | None = None
    vat_status: Literal["included", "excluded", "unknown"] = "unknown"


class Sale(DTO):
    source_text: Text
    menu_name: Text
    cups: Annotated[StrictInt, Field(ge=0)]
    period_text: Text | None = None
    kind: Literal["plan", "actual", "unknown"]


class Extraction(DTO):
    items: list[Quote]
    sales: list[Sale]
    delivery: list[Delivery]

class Item(DTO):
    item_id: Text
    name: Text
    base_unit: Unit
    aliases: list[Text] = Field(default_factory=list)
    specifications: list[Text] = Field(default_factory=list)


class Search(DTO):
    store_id: Text
    document_type: DocType
    query: Text
    dictionary_version: Annotated[int, Field(ge=1)] | None = None

class Normalize(DTO):
    store_id: Text
    dictionary_version: Annotated[int, Field(ge=1)]
    dictionary: list[Item]
    items: list[Quote]
    use_rag: bool = True

class Plan(DTO):
    menu_id: Text
    cups: Annotated[StrictInt, Field(ge=0)]
    takeaway_cups: Annotated[StrictInt, Field(ge=0)] | None = None


class RecipeLine(DTO):
    item_id: Text
    unit: Unit
    amount_per_cup: Annotated[Decimal, Field(gt=0)]
    scope: Literal["all", "takeaway"] = "all"


class Requirements(DTO):
    sales_plan: list[Plan]
    recipes: dict[str, list[RecipeLine]]
