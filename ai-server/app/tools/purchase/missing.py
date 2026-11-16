"""구매 계산에 필요한 칸이 비었을 때, 400 대신 needs_input으로 돌려줄 빈 칸 목록을 만든다.

폼·대화로 입력이 조금씩 쌓이면 견적·예산 같은 칸이 아직 없을 수 있다. 이것은 사장님이 채울 값이라
오류가 아니라 질문(needs_input + missing_fields)으로 돌려준다.

- 빈 칸으로 보는 것: 키가 없음, null, 빈 문자열, 빈 목록(품목·거래처·견적이 하나도 없음)
- 그대로 400인 것: 음수·없는 단위처럼 값이 틀린 경우, store_id·session_id·input_version_id가 빠진 경우
  (Spring이 채우는 칸이라 사장님께 물을 수 없다)
"""

from __future__ import annotations

from typing import Any

# Spring이 넣는 칸. 비면 사장님께 물을 수 없으니 400으로 둔다.
_SYSTEM_FIELDS = {"store_id", "session_id", "input_version_id"}

_TOP = {
    "planning_days": "계획 일수",
    "budget_krw": "예산",
    "max_delivery_count": "배송 횟수 한도",
    "items": "품목",
    "suppliers": "거래처",
    "quotes": "견적",
}
_ITEM = {
    "item_id": "품목 ID",
    "item_name": "품목 이름",
    "base_unit": "기준 단위",
    "gross_need": "필요량",
    "usable_inventory": "재고",
    "safety_stock": "안전재고",
}
_ITEM_QTY = {"gross_need", "usable_inventory", "safety_stock"}  # 단위가 품목 기준 단위인 칸
_SUPPLIER = {
    "supplier_id": "거래처 ID",
    "supplier_name": "거래처 이름",
    "minimum_order_krw": "최소 주문금액",
    "delivery_fee_krw": "배송비",
}
_QUOTE = {
    "supplier_id": "거래처",
    "item_id": "품목",
    "pack_size": "묶음 크기",
    "pack_unit": "묶음 단위",
    "pack_price_krw": "묶음 가격",
}
_SECTIONS = ["planning_days", "budget_krw", "max_delivery_count", "items", "suppliers", "quotes"]


def _is_blank_error(err: dict) -> bool:
    kind = err.get("type", "")
    value = err.get("input")
    if kind == "missing" or value is None:
        return True
    if kind == "too_short" and isinstance(value, list) and not value:
        return True
    return kind == "string_too_short" and isinstance(value, str) and not value.strip()


def _get(rows: Any, index: int) -> dict:
    if isinstance(rows, list) and 0 <= index < len(rows) and isinstance(rows[index], dict):
        return rows[index]
    return {}


def _text(row: dict, key: str) -> str | None:
    value = row.get(key)
    return value.strip() if isinstance(value, str) and value.strip() else None


def _field(raw: dict, loc: tuple) -> dict | None:
    """pydantic 오류 위치 하나를 {path, label, unit}로 바꾼다. 알 수 없는 위치면 None."""
    if not loc or loc[0] not in _TOP:
        return None
    section = loc[0]
    if len(loc) == 1:
        return {"path": section, "label": _TOP[section], "unit": None}
    if len(loc) != 3 or not isinstance(loc[1], int):
        return None
    index, key = loc[1], loc[2]
    path = f"{section}[{index}].{key}"

    if section == "items" and key in _ITEM:
        item = _get(raw.get("items"), index)
        name = _text(item, "item_name") or _text(item, "item_id") or f"{index + 1}번째 품목"
        unit = item.get("base_unit") if key in _ITEM_QTY and item.get("base_unit") in ("g", "ml", "ea") else None
        field = {"path": path, "label": f"{name} {_ITEM[key]}", "unit": unit}
        if _text(item, "item_id"):
            field["item_id"] = item["item_id"]
        return field

    if section == "suppliers" and key in _SUPPLIER:
        supplier = _get(raw.get("suppliers"), index)
        name = _text(supplier, "supplier_name") or _text(supplier, "supplier_id") or f"{index + 1}번째 거래처"
        return {"path": path, "label": f"{name} {_SUPPLIER[key]}", "unit": None}

    if section == "quotes" and key in _QUOTE:
        quote = _get(raw.get("quotes"), index)
        names = {s.get("supplier_id"): _text(s, "supplier_name") for s in raw.get("suppliers") or [] if isinstance(s, dict)}
        items = {i.get("item_id"): _text(i, "item_name") for i in raw.get("items") or [] if isinstance(i, dict)}
        who = names.get(quote.get("supplier_id")) or _text(quote, "supplier_id")
        what = items.get(quote.get("item_id")) or _text(quote, "item_id")
        owner = " ".join(x for x in (who, what) if x) or f"{index + 1}번째"
        return {"path": path, "label": f"{owner} 견적 {_QUOTE[key]}", "unit": None}

    return None


def _order(field: dict) -> tuple:
    path = field["path"]
    section = path.split("[")[0].split(".")[0]
    index = int(path.split("[")[1].split("]")[0]) if "[" in path else -1
    return (_SECTIONS.index(section), index, path)


def blank_fields(raw: Any, errors: list[dict]) -> list[dict] | None:
    """검사 오류가 모두 '빈 칸'이면 사장님께 물을 칸 목록을, 하나라도 틀린 값이 있으면 None(→ 400)."""
    if not isinstance(raw, dict) or not errors:
        return None
    fields: dict[str, dict] = {}
    for err in errors:
        loc = tuple(part for part in err.get("loc", ()) if part != "body")
        if not loc or loc[0] in _SYSTEM_FIELDS or not _is_blank_error(err):
            return None
        field = _field(raw, loc)
        if field is None:
            return None
        fields[field["path"]] = field
    # 재고 빈칸은 원래 needs_input이다. 다른 빈 칸과 함께 한 번에 묻는다.
    for index, item in enumerate(raw.get("items") or []):
        if isinstance(item, dict) and item.get("usable_inventory") is None:
            field = _field(raw, ("items", index, "usable_inventory"))
            fields.setdefault(field["path"], field)
    return sorted(fields.values(), key=_order)


def _particle(word: str) -> str:
    last = word[-1]
    if "가" <= last <= "힣":
        return "이" if (ord(last) - 0xAC00) % 28 else "가"
    return "이(가)"


def message(fields: list[dict]) -> str:
    labels = [f["label"] for f in fields]
    shown = ", ".join(labels[:3])
    if len(labels) > 3:
        shown += f" 외 {len(labels) - 3}개"
        return f"계산하려면 {shown} 값이 필요해요."
    return f"계산하려면 {shown}{_particle(shown)} 필요해요."
