import unicodedata

from fastapi import HTTPException
from app.rag.quote_search import search
from app.schemas.quote import Normalize, Search

CONVERT = {"kg": ("g", 1000), "g": ("g", 1), "L": ("ml", 1000),
           "ml": ("ml", 1), "개": ("개", 1)}

# 여러 개가 들어갈 수 있는 주문 단위. 이 말이 있는데 몇 개 들었는지 없으면 추측하지 않고 막는다.
PACK_WORDS = ("박스", "상자", "묶음", "줄", "팩", "세트", "케이스", "카톤", "box", "pack", "set", "case")


def key(value):
    return " ".join(unicodedata.normalize("NFKC", value).casefold().split())


def _pack_word(row):
    text = key(" ".join(t for t in (row.source_text, row.specification_text or "") if t))
    return next((w for w in PACK_WORDS if w in text), None)


def _assume_pack(row):
    """사장님 문자에 흔한 "원두 1kg 22,000원"처럼 주문 단위가 없는 줄을 채운다.

    - 묶음을 뜻하는 말이 없고 용량·가격이 하나씩이면 1개 단위로 판다고 본다(포장 1개, 단위 "개", 가격은 그 1개 값).
    - "1L 12개 31,000원"처럼 낱개 수가 있으면 그 수만큼 묶음 가격으로 본다.
    - 박스·묶음처럼 여러 개가 들 수 있는데 낱개 수가 없으면 채우지 않는다(지금처럼 막는다).
    채운 값이 있으면 True를 함께 돌려준다(화면에 "1개 가격으로 봤어요"를 보이게).
    """
    units, order_unit, basis = row.units_per_pack, row.order_unit, row.price_basis
    has_amount = row.quantity_per_unit is not None and row.quantity_per_unit > 0 and row.quantity_unit
    has_price = row.price is not None and row.price >= 0
    if not (has_amount and has_price):
        return units, order_unit, basis, False
    word = _pack_word(row)
    if units is None and word is None:
        units = 1
    if units is None or units <= 0:
        return units, order_unit, basis, False
    if not order_unit:
        order_unit = word or ("개" if units == 1 else "묶음")
    if basis is None:
        basis = "per_pack"
    changed = (units, order_unit, basis) != (row.units_per_pack, row.order_unit, row.price_basis)
    return units, order_unit, basis, changed


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
        units_per_pack, order_unit, price_basis, assumed = _assume_pack(row)
        if assumed:
            # 막지 않는 표시: 원문에 주문 단위가 없어 1개(또는 낱개 수만큼 묶음) 가격으로 봤다.
            issue("PACK_ASSUMED", "order_unit", False)
        if not order_unit:
            issue("MISSING_ORDER_UNIT", "order_unit")
        if row.price is None or row.price < 0:
            issue("INVALID_OR_MISSING_PRICE", "price")
        if price_basis is None:
            issue("MISSING_PRICE_BASIS", "price_basis")
        if row.vat_status == "unknown":
            issue("VAT_UNKNOWN", "vat_status", False)

        qty = None
        if units_per_pack is None or units_per_pack <= 0:
            issue("INVALID_OR_MISSING_PACK_COUNT", "units_per_pack")
        if row.quantity_per_unit is None or row.quantity_per_unit <= 0 or row.quantity_unit is None:
            issue("INVALID_OR_MISSING_UNIT_QUANTITY", "quantity_per_unit")
        elif item:
            unit, factor = CONVERT[row.quantity_unit]
            if unit != item.base_unit:
                issue("UNIT_MISMATCH", "quantity_unit")
            elif units_per_pack and units_per_pack > 0:
                qty = row.quantity_per_unit * factor * units_per_pack

        pack_price = None
        if row.price is not None and row.price >= 0:
            if price_basis == "per_pack":
                pack_price = row.price
            elif price_basis == "per_unit" and units_per_pack and units_per_pack > 0:
                pack_price = row.price * units_per_pack
        filled = {**row.model_dump(), "units_per_pack": units_per_pack, "order_unit": order_unit,
                  "price_basis": price_basis}
        rows.append(dict(**filled, line_id=line_id, item_id=item.item_id if item else None,
                         candidate_item_ids=candidates, normalized_quantity_per_pack=qty,
                         normalized_unit=item.base_unit if item else None, pack_price=pack_price,
                         comparable=not any(p["blocks_comparison"] for p in issues), issues=issues))
    return {"dictionary_version": req.dictionary_version, "items": rows}
