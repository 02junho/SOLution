import unicodedata

from fastapi import HTTPException
from app.rag.quote_search import search
from app.schemas.quote import Normalize, Search

CONVERT = {"kg": ("g", 1000), "g": ("g", 1), "L": ("ml", 1000),
           "ml": ("ml", 1), "개": ("개", 1)}

def key(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def normalize(req: Normalize):
    rows = []
    for i, row in enumerate(req.items, 1):
        line_id = f"quote-line-{i:03}"
        issues = []

        def issue(code, field, blocking=True):
            issues.append(dict(code=code, target_id=line_id, field=field,
                               blocks_comparison=blocking))

        matches = [item for item in req.dictionary if key(row.raw_item_name)
                   in {key(a) for a in [item.name, *item.aliases]}]
        item = matches[0] if len(matches) == 1 else None
        candidates = [m.item_id for m in matches]
        if item is None and not matches and req.use_rag:
            try:
                hit_rows = search(Search(store_id=req.store_id, query=row.raw_item_name,
                                         document_type="item_alias",
                                         dictionary_version=req.dictionary_version))["hits"]
                valid = {m.item_id for m in req.dictionary}
                candidates = list(dict.fromkeys(h["item_id"] for h in hit_rows if h["item_id"] in valid))
            except HTTPException as exc:
                if exc.status_code != 503:
                    raise
                issue("RAG_UNAVAILABLE", "item_id", False)
            # 기준 점수(rag_min_score)를 넘은 후보가 한 품목뿐이면 그 품목으로 정한다.
            # 사람이 확인할 수 있게 막지 않는 표시(ITEM_MATCHED_BY_RAG)를 남긴다.
            if len(candidates) == 1:
                item = next(m for m in req.dictionary if m.item_id == candidates[0])
                issue("ITEM_MATCHED_BY_RAG", "item_id", False)
        if item is None:
            issue("ITEM_CONFIRMATION_REQUIRED", "item_id")
        if not row.supplier_name:
            issue("MISSING_SUPPLIER", "supplier_name")
        if not row.order_unit:
            issue("MISSING_ORDER_UNIT", "order_unit")
        if row.price is None or row.price < 0:
            issue("INVALID_OR_MISSING_PRICE", "price")
        if row.price_basis is None:
            issue("MISSING_PRICE_BASIS", "price_basis")
        if row.vat_status == "unknown":
            issue("VAT_UNKNOWN", "vat_status", False)

        qty = None
        if row.units_per_pack is None or row.units_per_pack <= 0:
            issue("INVALID_OR_MISSING_PACK_COUNT", "units_per_pack")
        if row.quantity_per_unit is None or row.quantity_per_unit <= 0 or row.quantity_unit is None:
            issue("INVALID_OR_MISSING_UNIT_QUANTITY", "quantity_per_unit")
        elif item:
            unit, factor = CONVERT[row.quantity_unit]
            if unit != item.base_unit:
                issue("UNIT_MISMATCH", "quantity_unit")
            elif row.units_per_pack and row.units_per_pack > 0:
                qty = row.quantity_per_unit * factor * row.units_per_pack

        pack_price = None
        if row.price is not None and row.price >= 0:
            if row.price_basis == "per_pack":
                pack_price = row.price
            elif row.price_basis == "per_unit" and row.units_per_pack and row.units_per_pack > 0:
                pack_price = row.price * row.units_per_pack
        rows.append(dict(**row.model_dump(), line_id=line_id, item_id=item.item_id if item else None,
                         candidate_item_ids=candidates, normalized_quantity_per_pack=qty,
                         normalized_unit=item.base_unit if item else None, pack_price=pack_price,
                         comparable=not any(p["blocks_comparison"] for p in issues), issues=issues))
    return {"dictionary_version": req.dictionary_version, "items": rows}
