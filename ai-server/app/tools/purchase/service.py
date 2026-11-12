"""구매 최적화 결과를 노션 API 명세서 "구매 최적화"의 응답 모양으로 만든다.

- 재고가 빈칸(null)이면 needs_input. 0으로 채우지 않는다.
- 견적이 없는 품목이 있거나 조건을 지키는 안이 없으면 infeasible + violations·suggestions.
- 그 밖에는 ok + 구매안 2개(purchase_1 총비용 최소 / purchase_2 배송 1회)와 기준선(비교용).
"""

from __future__ import annotations

from app.core.response import ApiResponse, infeasible, needs_input, ok
from app.tools.purchase.optimizer import (
    Plan,
    Prepared,
    baseline,
    bought_of,
    over_storage,
    baseline_violations,
    diagnose,
    prepare,
    quote_label,
    solve,
)
from app.tools.purchase.schemas import PurchaseRequest

ASSUMPTIONS = ["거래처 1곳 = 배송 1회"]
LABELS = {"budget": "예산", "delivery_count": "배송 횟수", "minimum_order": "최소 주문금액", "storage": "보관 한도"}


def run(req: PurchaseRequest) -> ApiResponse[dict]:
    missing = [
        {"path": f"items[{i}].usable_inventory", "item_id": item.item_id, "label": f"{item.item_name} 재고", "unit": item.base_unit}
        for i, item in enumerate(req.items)
        if item.usable_inventory is None
    ]
    if missing:
        labels = ", ".join(m["label"] for m in missing)
        return needs_input({"detail_status": "NEEDS_INPUT", "missing_fields": missing}, f"{labels}가 지금 얼마나 있나요?")

    p = prepare(req)  # 값끼리 맞지 않으면 InputError → 400
    if p.no_quote_items:
        return _no_quote(p)

    plan1 = solve(p, req.max_delivery_count)
    if plan1 is None:
        return _infeasible(p)

    plan2 = plan1 if req.max_delivery_count == 1 else solve(p, 1)
    base = baseline(p)
    choices = [_choice_summary(p, "purchase_1", "총비용 최소", plan1, base)]
    detail_choices = [_choice_detail(p, "purchase_1", plan1)]
    if plan2 is None:
        choices.append({"choice_key": "purchase_2", "label": "배송 1회", "available": False, "same_as": None,
                        "unavailable_reason": _one_delivery_reason(p)})
    elif plan2.pack_counts == plan1.pack_counts:
        choices.append({"choice_key": "purchase_2", "label": "배송 1회", "available": True, "same_as": "purchase_1"})
    else:
        choices.append(_choice_summary(p, "purchase_2", "배송 1회", plan2, base))
        detail_choices.append(_choice_detail(p, "purchase_2", plan2))

    warnings = _vat_warnings(p, {"purchase_1": plan1, **({"purchase_2": plan2} if len(detail_choices) == 2 else {})})
    for choice in choices:
        if choice.get("available") and choice.get("same_as") is None:
            choice["warning_ids"] = [w["warning_id"] for w in warnings if choice["choice_key"] in w["choice_keys"]]

    optimal = plan1.optimal and (plan2 is None or plan2.optimal)
    return ok({
        "detail_status": "OPTIMAL" if optimal else "FEASIBLE",
        "summary": {
            "choices": choices,
            "baseline": {"label": "단위단가순 담기 (비교용)", "total_krw": base.total_krw, "confirmable": False},
            "warnings": warnings,
            "assumptions": list(ASSUMPTIONS),
        },
        "detail": {
            "buy_needs": [
                {"item_id": i.item_id, "base_unit": i.base_unit, "gross_need": _n(i.gross_need),
                 "usable_inventory": _n(i.usable_inventory), "safety_stock": _n(i.safety_stock),
                 "buy_need": _n(p.buy_need[i.item_id])}
                for i in req.items
            ],
            "choices": detail_choices,
            "baseline": {
                "method": "품목마다 단위가격이 가장 싼 견적을 골라 필요량만큼 올림",
                "lines": [
                    {"supplier_id": req.quotes[q].supplier_id, "item_id": req.quotes[q].item_id,
                     "pack_size": _n(req.quotes[q].pack_size), "pack_count": n,
                     "line_krw": req.quotes[q].pack_price_krw * n}
                    for q, n in sorted(base.pack_counts.items())
                ],
                "total_krw": base.total_krw,
                "constraint_violations": baseline_violations(p, base),
            },
        },
    })


def _choice_summary(p: Prepared, key: str, label: str, plan: Plan, base: Plan) -> dict:
    names = {s.supplier_id: s.supplier_name for s in p.req.suppliers}
    return {
        "choice_key": key,
        "label": label,
        "available": True,
        "same_as": None,
        "total_krw": plan.total_krw,
        "goods_krw": plan.goods_krw,
        "delivery_fee_krw": plan.delivery_fee_krw,
        "delivery_count": len(plan.suppliers),
        "supplier_totals": [
            {"supplier_id": sid, "supplier_name": names[sid], "goods_krw": g, "delivery_fee_krw": plan.fee_by_supplier[sid]}
            for sid, g in plan.goods_by_supplier.items()
        ],
        "diff_from_baseline_krw": plan.total_krw - base.total_krw,
        "constraints_met": {"budget": True, "minimum_order": True, "storage": True, "delivery_count": True},
        "warning_ids": [],
    }


def _choice_detail(p: Prepared, key: str, plan: Plan) -> dict:
    req = p.req
    order = {s.supplier_id: k for k, s in enumerate(req.suppliers)}
    lines = [
        {"supplier_id": req.quotes[q].supplier_id, "item_id": req.quotes[q].item_id,
         "pack_size": _n(req.quotes[q].pack_size), "pack_unit": req.quotes[q].pack_unit,
         "pack_price_krw": req.quotes[q].pack_price_krw, "pack_count": n,
         "line_krw": req.quotes[q].pack_price_krw * n, "vat_included": req.quotes[q].vat_included}
        for q, n in sorted(plan.pack_counts.items(), key=lambda kv: (order[req.quotes[kv[0]].supplier_id], kv[0]))
    ]
    stock_after = []
    for item in req.items:
        bought = bought_of(p, plan, item.item_id)
        after = (item.usable_inventory or 0.0) + bought
        stock_after.append({"item_id": item.item_id, "bought": _n(bought), "after_delivery": _n(after),
                            "end_of_period": _n(after - item.gross_need)})
    return {"choice_key": key, "lines": lines, "stock_after": stock_after, "order_messages": _order_messages(p, plan)}


def _order_messages(p: Prepared, plan: Plan) -> list[dict]:
    """주문 문구 초안. 실제로 보내지 않는다 (URQ-PUR-005)."""
    req = p.req
    item_names = {i.item_id: i.item_name for i in req.items}
    messages = []
    for sid, goods in plan.goods_by_supplier.items():
        rows = [
            f"- {item_names[req.quotes[q].item_id]} {quote_label(req.quotes[q])} × {n}개"
            for q, n in sorted(plan.pack_counts.items())
            if req.quotes[q].supplier_id == sid
        ]
        fee = plan.fee_by_supplier[sid]
        text = "\n".join([
            "안녕하세요. 아래와 같이 주문 부탁드립니다.",
            *rows,
            f"상품 {goods:,}원 + 배송비 {fee:,}원 = {goods + fee:,}원",
            "확인 부탁드립니다.",
        ])
        messages.append({"supplier_id": sid, "text": text})
    return messages


def _vat_warnings(p: Prepared, plans: dict[str, Plan]) -> list[dict]:
    """부가세 포함 여부를 모르는 견적이 구매안에 쓰이면 경고 (URQ-QUO-004). 계산은 표시 가격 그대로 한다."""
    req = p.req
    names = {s.supplier_id: s.supplier_name for s in req.suppliers}
    items = {i.item_id: i.item_name for i in req.items}
    keys: list[str] = []
    descs: list[str] = []
    for key, plan in plans.items():
        unknown = [q for q in plan.pack_counts if req.quotes[q].vat_included is None]
        if unknown:
            keys.append(key)
            for q in unknown:
                d = f"{names[req.quotes[q].supplier_id]} {items[req.quotes[q].item_id]}({quote_label(req.quotes[q])})"
                if d not in descs:
                    descs.append(d)
    if not keys:
        return []
    return [{
        "warning_id": "VAT_UNKNOWN",
        "requires_ack": True,
        "choice_keys": keys,
        "message": f"{', '.join(descs)}는 부가세 포함 여부를 모릅니다. 총액이 달라질 수 있어요.",
    }]


def _one_delivery_reason(p: Prepared) -> str:
    req = p.req
    needed = [i for i in req.items if p.buy_need[i.item_id] > 0]
    covers_all = [
        s for s in req.suppliers
        if all(any(req.quotes[q].supplier_id == s.supplier_id for q in p.quotes_by_item[i.item_id]) for i in needed)
    ]
    if not covers_all:
        names = {s.supplier_id: s.supplier_name for s in req.suppliers}
        where = " · ".join(
            f"{i.item_name}: {', '.join(dict.fromkeys(names[req.quotes[q].supplier_id] for q in p.quotes_by_item[i.item_id]))}"
            for i in needed
        )
        return f"한 거래처에서 모든 품목을 살 수 없어요. ({where})"
    group, _ = diagnose(p, 1)
    if group == ("budget",):
        return "배송 1회로 사면 예산을 넘어요."
    if group == ("minimum_order",):
        return "배송 1회로는 거래처 최소 주문금액을 맞출 수 없어요."
    if group == ("storage",):
        return "배송 1회로 사면 보관 한도를 넘어요."
    return "배송 1회로는 조건을 지키는 구매안이 없어요."


def _no_quote(p: Prepared) -> ApiResponse[dict]:
    names = [next(i.item_name for i in p.req.items if i.item_id == iid) for iid in p.no_quote_items]
    joined = ", ".join(names)
    return infeasible(
        {
            "detail_status": "INFEASIBLE",
            "violations": [{"constraint": "no_quote", "label": "견적이 없는 품목", "item_ids": list(p.no_quote_items)}],
            "suggestions": [f"{joined} 견적을 추가하기"],
        },
        f"{joined} 견적이 없어서 구매안을 만들 수 없어요.",
    )


def _infeasible(p: Prepared) -> ApiResponse[dict]:
    req = p.req
    group, relaxed = diagnose(p, req.max_delivery_count)
    violations: list[dict] = []
    suggestions: list[str] = []
    for name in group:
        v: dict = {"constraint": name, "label": LABELS[name]}
        if name == "budget":
            v["budget_krw"] = req.budget_krw
            if group == ("budget",) and relaxed is not None:
                v["required_min_krw"] = relaxed.total_krw
                suggestions.append(f"예산을 {relaxed.total_krw:,}원 이상으로 늘리기")
            else:
                suggestions.append("예산을 늘리기")
            suggestions.append("안전재고를 줄이기")
        elif name == "delivery_count":
            v["max_delivery_count"] = req.max_delivery_count
            if relaxed is not None:
                v["required_min"] = len(relaxed.suppliers)
                suggestions.append(f"배송 횟수를 {len(relaxed.suppliers)}회까지 허용하기")
        elif name == "minimum_order":
            if relaxed is not None:
                mins = {s.supplier_id: s.minimum_order_krw for s in req.suppliers}
                v["supplier_ids"] = [sid for sid, g in relaxed.goods_by_supplier.items() if g < mins[sid]]
            suggestions.append("최소 주문금액이 낮은 거래처 견적 추가하기")
        elif name == "storage":
            if relaxed is not None:
                v["item_ids"] = over_storage(p, relaxed)
            suggestions.append("보관 한도를 늘리거나 안전재고를 줄이기")
        violations.append(v)

    if group == ("budget",) and relaxed is not None:
        message = f"예산 {req.budget_krw:,}원으로는 필요한 양을 살 수 없어요. 최소 {relaxed.total_krw:,}원이 필요해요."
    elif group == ("delivery_count",) and relaxed is not None:
        message = f"배송 {req.max_delivery_count}회로는 필요한 양을 살 수 없어요. 최소 {len(relaxed.suppliers)}회가 필요해요."
    elif len(group) == 1:
        message = f"{LABELS[group[0]]} 조건 때문에 필요한 양을 살 수 없어요."
    else:
        message = f"{', '.join(LABELS[g] for g in group)} 조건이 함께 맞지 않아 구매안을 만들 수 없어요."
    return infeasible({"detail_status": "INFEASIBLE", "violations": violations, "suggestions": suggestions}, message)


def _n(value: float | None):
    """정수로 떨어지는 수는 정수로 (JSON에 2700.0 대신 2700)."""
    if value is None:
        return None
    return int(value) if float(value).is_integer() else value

