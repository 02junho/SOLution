"""기존 팀 에이전트가 선택해서 사용할 견적 도구 노드. 체크포인터를 만들지 않는다."""

from app.schemas.quote import Normalize, ParseInput
from app.tools.quote.normalize import normalize
from app.tools.quote.parse import parse


def quote_node(state: dict) -> dict:
    extracted = parse(ParseInput(text=state["quote_text"], supplier_name=state.get("supplier_name")))
    normalized = normalize(Normalize(
        store_id=state["store_id"], dictionary_version=state["dictionary_version"],
        dictionary=state["dictionary"], items=extracted.items, use_rag=state.get("use_rag", True),
    ))
    rows = normalized["items"]
    return {
        "quote_items": rows,
        "sales_candidates": [sale.model_dump(mode="json") for sale in extracted.sales],
        "delivery": [rule.model_dump(mode="json") for rule in extracted.delivery],
        "quote_issues": [issue for row in rows for issue in row["issues"]],
    }
