"""구매 최적화 계산 (PuLP + HiGHS). LLM을 부르지 않고, 같은 입력이면 항상 같은 결과가 나온다.

- 살 양 = max(0, 총필요량 + 안전재고 − 가용재고). 재고 차감은 여기서 한 번만 한다 (URQ-PUR-001).
- 변수: 견적별 묶음 수(정수), 거래처 사용 여부, 거래처 무료배송 달성 여부.
- 조건: 필요량 충족, 보관 한도, 거래처 최소 주문금액, 배송 횟수 한도(거래처 1곳 = 배송 1회), 예산.
- 목표: 상품값 + 배송비 최소. 금액이 같으면 묶음 수가 적은 쪽.
- 조건을 지키는 안이 없으면 조건을 하나씩(그다음 둘씩) 풀어 보며 어떤 조건 때문인지 찾는다.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from itertools import combinations

import pulp

from app.tools.purchase.schemas import PurchaseItem, PurchaseQuote, PurchaseRequest

TIME_LIMIT_SEC = 5
RELAXABLE = ("budget", "delivery_count", "minimum_order", "storage")
# 금액이 같은 안 중 묶음 수가 적은 쪽을 고르기 위한 아주 작은 가중치. 금액(원 단위 정수)에는 영향이 없다.
_PACK_TIE_BREAK = 1e-4


class InputError(ValueError):
    """요청 안의 값끼리 맞지 않음 (없는 거래처·품목, 단위 불일치 등). 400으로 돌려준다."""


@dataclass
class Plan:
    """한 번 풀어서 나온 구매안."""

    pack_counts: dict[int, int]  # quote index → 묶음 수 (0인 견적은 빠짐)
    goods_by_supplier: dict[str, int]
    fee_by_supplier: dict[str, int]
    optimal: bool

    @property
    def goods_krw(self) -> int:
        return sum(self.goods_by_supplier.values())

    @property
    def delivery_fee_krw(self) -> int:
        return sum(self.fee_by_supplier.values())

    @property
    def total_krw(self) -> int:
        return self.goods_krw + self.delivery_fee_krw

    @property
    def suppliers(self) -> list[str]:
        return list(self.goods_by_supplier)


@dataclass
class Prepared:
    """요청을 계산하기 좋게 정리한 것."""

    req: PurchaseRequest
    buy_need: dict[str, float]
    quotes_by_item: dict[str, list[int]]
    quotes_by_supplier: dict[str, list[int]]
    no_quote_items: list[str] = field(default_factory=list)


def prepare(req: PurchaseRequest) -> Prepared:
    item_ids = [i.item_id for i in req.items]
    supplier_ids = [s.supplier_id for s in req.suppliers]
    if len(set(item_ids)) != len(item_ids):
        raise InputError("품목 ID가 겹칩니다.")
    if len(set(supplier_ids)) != len(supplier_ids):
        raise InputError("거래처 ID가 겹칩니다.")
    items = {i.item_id: i for i in req.items}

    quotes_by_item: dict[str, list[int]] = {i: [] for i in item_ids}
    quotes_by_supplier: dict[str, list[int]] = {s: [] for s in supplier_ids}
    for q_idx, q in enumerate(req.quotes):
        if q.supplier_id not in quotes_by_supplier:
            raise InputError(f"quotes[{q_idx}]의 거래처 {q.supplier_id}가 suppliers에 없습니다.")
        if q.item_id not in items:
            raise InputError(f"quotes[{q_idx}]의 품목 {q.item_id}가 items에 없습니다.")
        if q.pack_unit != items[q.item_id].base_unit:
            raise InputError(
                f"quotes[{q_idx}]의 단위({q.pack_unit})가 품목 {q.item_id}의 기준 단위({items[q.item_id].base_unit})와 다릅니다."
            )
        quotes_by_item[q.item_id].append(q_idx)
        quotes_by_supplier[q.supplier_id].append(q_idx)

    buy_need = {
        i.item_id: max(0.0, i.gross_need + i.safety_stock - (i.usable_inventory or 0.0)) for i in req.items
    }
    no_quote = [i for i in item_ids if buy_need[i] > 0 and not quotes_by_item[i]]
    return Prepared(req, buy_need, quotes_by_item, quotes_by_supplier, no_quote)


def _upper_bound(p: Prepared, q_idx: int, relax: tuple[str, ...] = ()) -> int:
    """견적 하나로 살 수 있는 묶음 수의 상한. 필요량 + 최소 주문·무료배송을 채우려고 더 사는 정도까지만 허용한다."""
    q = p.req.quotes[q_idx]
    item = next(i for i in p.req.items if i.item_id == q.item_id)
    supplier = next(s for s in p.req.suppliers if s.supplier_id == q.supplier_id)
    top_up_krw = max(supplier.minimum_order_krw, supplier.free_delivery_min_krw or 0)
    ub = math.ceil(p.buy_need[q.item_id] / q.pack_size) + math.ceil(top_up_krw / max(q.pack_price_krw, 1)) + 1
    if item.storage_capacity is not None and "storage" not in relax:
        ub = min(ub, math.floor(storage_room(item) / q.pack_size))
    return max(0, ub)


def storage_room(item: PurchaseItem) -> float:
    """보관 한도까지 새로 들일 수 있는 양. 지금 재고가 이미 한도를 넘었으면 0 (안 사는 건 언제나 괜찮다)."""
    if item.storage_capacity is None:
        return math.inf
    return max(0.0, item.storage_capacity - (item.usable_inventory or 0.0))


def bought_of(p: Prepared, plan: Plan, item_id: str) -> float:
    return sum(p.req.quotes[q].pack_size * n for q, n in plan.pack_counts.items() if p.req.quotes[q].item_id == item_id)


def over_storage(p: Prepared, plan: Plan) -> list[str]:
    """보관 한도를 넘게 사는 품목 ID."""
    return [i.item_id for i in p.req.items if bought_of(p, plan, i.item_id) > storage_room(i)]


def solve(p: Prepared, max_delivery_count: int, relax: tuple[str, ...] = ()) -> Plan | None:
    """조건을 지키는 가장 싼 구매안. relax에 넣은 조건은 빼고 푼다(원인 찾기용). 답이 없으면 None."""
    req = p.req
    prob = pulp.LpProblem("purchase", pulp.LpMinimize)
    x = {
        q_idx: prob.add_variable(f"packs_{q_idx}", lowBound=0, upBound=_upper_bound(p, q_idx, relax), cat="Integer")
        for q_idx in range(len(req.quotes))
    }
    use = {s.supplier_id: prob.add_variable(f"use_{k}", cat="Binary") for k, s in enumerate(req.suppliers)}
    free = {s.supplier_id: prob.add_variable(f"free_{k}", cat="Binary") for k, s in enumerate(req.suppliers)}

    goods = {
        sid: pulp.lpSum(req.quotes[q].pack_price_krw * x[q] for q in p.quotes_by_supplier[sid]) for sid in use
    }
    fees = {}
    for k, s in enumerate(req.suppliers):
        sid = s.supplier_id
        for q in p.quotes_by_supplier[sid]:
            prob += x[q] <= (x[q].upBound or 0) * use[sid], f"link_{q}"
        prob += free[sid] <= use[sid], f"free_needs_use_{k}"
        if s.free_delivery_min_krw is None:
            prob += free[sid] == 0, f"no_free_{k}"
        else:
            prob += goods[sid] >= s.free_delivery_min_krw * free[sid], f"free_min_{k}"
        fees[sid] = s.delivery_fee_krw * (use[sid] - free[sid])
        if "minimum_order" not in relax:
            prob += goods[sid] >= s.minimum_order_krw * use[sid], f"minimum_order_{k}"

    for k, item in enumerate(req.items):
        bought = pulp.lpSum(req.quotes[q].pack_size * x[q] for q in p.quotes_by_item[item.item_id])
        if p.buy_need[item.item_id] > 0:
            prob += bought >= p.buy_need[item.item_id], f"need_{k}"
        if item.storage_capacity is not None and "storage" not in relax:
            prob += bought <= storage_room(item), f"storage_{k}"

    if "delivery_count" not in relax:
        prob += pulp.lpSum(use.values()) <= max_delivery_count, "delivery_count"
    total = pulp.lpSum(goods.values()) + pulp.lpSum(fees.values())
    if "budget" not in relax:
        prob += total <= req.budget_krw, "budget"

    prob += total + _PACK_TIE_BREAK * pulp.lpSum(x.values())
    stats = prob.solve(pulp.HiGHS(msg=False, timeLimit=TIME_LIMIT_SEC, gapRel=0, gapAbs=0, threads=1))
    if not stats.has_solution:
        return None

    counts = {q: round(v.value()) for q, v in x.items() if v.value() and round(v.value()) > 0}
    goods_by_supplier: dict[str, int] = {}
    fee_by_supplier: dict[str, int] = {}
    for s in req.suppliers:
        sid = s.supplier_id
        g = sum(req.quotes[q].pack_price_krw * counts.get(q, 0) for q in p.quotes_by_supplier[sid])
        if g <= 0:
            continue
        goods_by_supplier[sid] = g
        is_free = s.free_delivery_min_krw is not None and g >= s.free_delivery_min_krw
        fee_by_supplier[sid] = 0 if is_free else s.delivery_fee_krw
    return Plan(counts, goods_by_supplier, fee_by_supplier, optimal=stats.status == pulp.LpSolveStatus.Optimal)


def baseline(p: Prepared) -> Plan:
    """기준선: 품목마다 단위가격이 가장 싼 견적을 골라 필요량만큼 묶음 수를 올린다. 거래처 조건은 보지 않는다."""
    req = p.req
    counts: dict[int, int] = {}
    for item in req.items:
        need = p.buy_need[item.item_id]
        if need <= 0 or not p.quotes_by_item[item.item_id]:
            continue
        best = min(
            p.quotes_by_item[item.item_id],
            key=lambda q: (req.quotes[q].pack_price_krw / req.quotes[q].pack_size, req.quotes[q].pack_price_krw, q),
        )
        counts[best] = math.ceil(need / req.quotes[best].pack_size)
    goods: dict[str, int] = {}
    for q, n in counts.items():
        sid = req.quotes[q].supplier_id
        goods[sid] = goods.get(sid, 0) + req.quotes[q].pack_price_krw * n
    fees = {}
    for s in req.suppliers:
        if s.supplier_id in goods:
            free = s.free_delivery_min_krw is not None and goods[s.supplier_id] >= s.free_delivery_min_krw
            fees[s.supplier_id] = 0 if free else s.delivery_fee_krw
    ordered = {s.supplier_id: goods[s.supplier_id] for s in req.suppliers if s.supplier_id in goods}
    return Plan(counts, ordered, fees, optimal=True)


def baseline_violations(p: Prepared, plan: Plan) -> list[str]:
    """기준선이 어긴 조건 이름 (비교 설명용)."""
    req = p.req
    broken = []
    if plan.total_krw > req.budget_krw:
        broken.append("budget")
    if len(plan.suppliers) > req.max_delivery_count:
        broken.append("delivery_count")
    mins = {s.supplier_id: s.minimum_order_krw for s in req.suppliers}
    if any(g < mins[sid] for sid, g in plan.goods_by_supplier.items()):
        broken.append("minimum_order")
    if over_storage(p, plan):
        broken.append("storage")
    return broken


def diagnose(p: Prepared, max_delivery_count: int) -> tuple[tuple[str, ...], Plan | None]:
    """답이 없을 때, 어떤 조건을 풀면 답이 생기는지. (풀어야 하는 조건들, 그때의 구매안)"""
    for size in (1, 2, len(RELAXABLE)):
        for group in combinations(RELAXABLE, size):
            plan = solve(p, max_delivery_count, relax=group)
            if plan is not None:
                return group, plan
    return RELAXABLE, None


def quote_label(q: PurchaseQuote) -> str:
    """주문 문구용 묶음 표기. 1000g → 1kg, 12000ml → 12L."""
    size = q.pack_size
    if q.pack_unit == "g" and size >= 1000:
        return f"{_num(size / 1000)}kg"
    if q.pack_unit == "ml" and size >= 1000:
        return f"{_num(size / 1000)}L"
    unit = {"g": "g", "ml": "ml", "ea": "개"}[q.pack_unit]
    return f"{_num(size)}{unit}"


def _num(value: float) -> str:
    return f"{int(value):,}" if float(value).is_integer() else f"{value:,.2f}".rstrip("0").rstrip(".")
