"""구매 최적화의 독립 정답 계산과 검산. 앱 코드와 PuLP를 쓰지 않고, 명세의 규칙만으로 다시 계산한다.

- best_total: 가능한 묶음 수를 전부 세어 가장 싼 총액을 찾는다 (작은 사례 전용).
- baseline_total: 기준선(품목마다 단위가격이 가장 싼 견적, 필요량만큼 올림)을 다시 계산한다.
- check_plan: 도구가 돌려준 구매안을 다시 합산하고 모든 조건을 따로 확인한다.

규칙 (노션·드라이브 API 명세 「POST /tools/purchase」 기준)
- 살 양 = max(0, 총필요량 + 안전재고 − 재고)
- 보관 한도: 산 양 ≤ max(0, 보관 한도 − 재고)
- 기간 끝 재고 한도: 산 양 ≤ max(0, 한도 + 총필요량 − 재고)
- 거래처 1곳 = 배송 1회. 주문한 거래처는 최소 주문금액 이상. 무료배송 기준 이상이면 배송비 0
- 총액 = 상품값 + 배송비 ≤ 예산
"""

from __future__ import annotations

import itertools
import math

MAX_COMBINATIONS = 2_000_000
# 소수 수량(0.7 / 0.1 = 6.999…)의 부동소수점 오차를 넘기는 허용 오차.
EPS = 1e-9


class TooLarge(ValueError):
    """전수 열거로 풀기엔 너무 큰 사례."""


def buy_need(item: dict) -> float:
    return max(0.0, item["gross_need"] + item["safety_stock"] - item["usable_inventory"])


def room(item: dict) -> float:
    """보관 한도·기간 끝 재고 한도 때문에 새로 들일 수 있는 최대량."""
    limit = math.inf
    if item.get("storage_capacity") is not None:
        limit = min(limit, max(0.0, item["storage_capacity"] - item["usable_inventory"]))
    if item.get("max_end_inventory") is not None:
        limit = min(limit, max(0.0, item["max_end_inventory"] + item["gross_need"] - item["usable_inventory"]))
    return limit


def _supplier_cost(supplier: dict, goods: int) -> int:
    free = supplier.get("free_delivery_min_krw")
    return goods + (0 if free is not None and goods >= free else supplier["delivery_fee_krw"])


def best_total(req: dict, max_delivery_count: int) -> int | None:
    """조건을 모두 지키는 안의 최저 총액. 없으면 None."""
    quotes = req["quotes"]
    per_item: list[list[dict[int, int]]] = []
    for item in req["items"]:
        idxs = [k for k, q in enumerate(quotes) if q["item_id"] == item["item_id"]]
        need, cap = buy_need(item), room(item)
        domains = []
        for k in idxs:
            q = quotes[k]
            by_budget = req["budget_krw"] // q["pack_price_krw"] if q["pack_price_krw"] > 0 else math.inf
            by_room = math.floor(cap / q["pack_size"] + EPS) if cap != math.inf else math.inf
            top = min(by_budget, by_room)
            if top == math.inf:
                raise TooLarge(f"{item['item_id']} 견적 {k}의 상한이 없습니다.")
            domains.append(range(int(top) + 1))
        options = []
        for counts in itertools.product(*domains):
            bought = sum(quotes[k]["pack_size"] * n for k, n in zip(idxs, counts))
            cost = sum(quotes[k]["pack_price_krw"] * n for k, n in zip(idxs, counts))
            if bought >= need - EPS and bought <= cap + EPS and cost <= req["budget_krw"]:
                options.append(dict(zip(idxs, counts)))
        if not options:
            return None
        per_item.append(options)

    if math.prod(len(o) for o in per_item) > MAX_COMBINATIONS:
        raise TooLarge("조합 수가 너무 많습니다.")

    suppliers = {s["supplier_id"]: s for s in req["suppliers"]}
    best = None
    for pick in itertools.product(*per_item):
        goods: dict[str, int] = {}
        for part in pick:
            for k, n in part.items():
                if n:
                    sid = quotes[k]["supplier_id"]
                    goods[sid] = goods.get(sid, 0) + quotes[k]["pack_price_krw"] * n
        used = [sid for sid, g in goods.items() if g > 0]
        if len(used) > max_delivery_count:
            continue
        if any(goods[sid] < suppliers[sid]["minimum_order_krw"] for sid in used):
            continue
        total = sum(_supplier_cost(suppliers[sid], goods[sid]) for sid in used)
        if total <= req["budget_krw"] and (best is None or total < best):
            best = total
    return best


def baseline_total(req: dict) -> int:
    """품목마다 단위가격이 가장 싼 견적(같으면 묶음 가격이 싼 쪽, 그다음 앞쪽)을 골라 필요량만큼 올린다."""
    quotes = req["quotes"]
    goods: dict[str, int] = {}
    for item in req["items"]:
        need = buy_need(item)
        idxs = [k for k, q in enumerate(quotes) if q["item_id"] == item["item_id"]]
        if need <= 0 or not idxs:
            continue
        k = min(idxs, key=lambda j: (quotes[j]["pack_price_krw"] / quotes[j]["pack_size"], quotes[j]["pack_price_krw"], j))
        sid = quotes[k]["supplier_id"]
        goods[sid] = goods.get(sid, 0) + quotes[k]["pack_price_krw"] * math.ceil(need / quotes[k]["pack_size"])
    suppliers = {s["supplier_id"]: s for s in req["suppliers"]}
    return sum(_supplier_cost(suppliers[sid], g) for sid, g in goods.items())


def check_plan(req: dict, summary: dict, detail: dict) -> list[str]:
    """도구가 돌려준 구매안 하나를 다시 합산하고 조건을 확인한다. 어긋난 점을 문장으로 돌려준다 (없으면 빈 목록)."""
    problems: list[str] = []
    key = summary["choice_key"]
    suppliers = {s["supplier_id"]: s for s in req["suppliers"]}
    items = {i["item_id"]: i for i in req["items"]}
    quote_ids = {(q["supplier_id"], q["item_id"], q["pack_size"], q["pack_price_krw"]) for q in req["quotes"]}

    goods: dict[str, int] = {}
    bought: dict[str, float] = {iid: 0.0 for iid in items}
    for line in detail["lines"]:
        sig = (line["supplier_id"], line["item_id"], line["pack_size"], line["pack_price_krw"])
        if sig not in quote_ids:
            problems.append(f"{key}: 요청에 없는 견적을 썼습니다 {sig}")
        n = line["pack_count"]
        if not isinstance(n, int) or n <= 0:
            problems.append(f"{key}: 묶음 수가 양의 정수가 아닙니다 ({n})")
        if line["line_krw"] != line["pack_price_krw"] * n:
            problems.append(f"{key}: 줄 금액이 맞지 않습니다 {line}")
        goods[line["supplier_id"]] = goods.get(line["supplier_id"], 0) + line["pack_price_krw"] * n
        bought[line["item_id"]] += line["pack_size"] * n

    goods_total = sum(goods.values())
    fee_total = sum(_supplier_cost(suppliers[sid], g) - g for sid, g in goods.items())
    total = goods_total + fee_total
    if total != summary["total_krw"]:
        problems.append(f"{key}: 다시 합산한 총액 {total:,}원 ≠ 돌려준 총액 {summary['total_krw']:,}원")
    if goods_total != summary["goods_krw"]:
        problems.append(f"{key}: 다시 합산한 상품값 {goods_total:,}원 ≠ 돌려준 상품값 {summary['goods_krw']:,}원")
    if fee_total != summary["delivery_fee_krw"]:
        problems.append(f"{key}: 다시 계산한 배송비 {fee_total:,}원 ≠ 돌려준 배송비 {summary['delivery_fee_krw']:,}원")
    if total > req["budget_krw"]:
        problems.append(f"{key}: 예산 초과")
    if len(goods) != summary["delivery_count"]:
        problems.append(f"{key}: 배송 횟수 표시가 거래처 수와 다릅니다")
    limit = 1 if key == "purchase_2" else req["max_delivery_count"]
    if len(goods) > limit:
        problems.append(f"{key}: 배송 횟수 {len(goods)}회 > 한도 {limit}회")
    for sid, g in goods.items():
        if g < suppliers[sid]["minimum_order_krw"]:
            problems.append(f"{key}: {sid} 최소 주문금액 미달")
    for iid, item in items.items():
        if bought[iid] < buy_need(item) - EPS:
            problems.append(f"{key}: {iid} 필요량 부족")
        if bought[iid] > room(item) + EPS:
            problems.append(f"{key}: {iid} 보관 한도 또는 기간 끝 재고 한도 초과")
    stock_ids = [row["item_id"] for row in detail["stock_after"]]
    if sorted(stock_ids) != sorted(items):
        problems.append(f"{key}: 입고 후 재고 줄의 품목 {stock_ids}이 요청 품목 {sorted(items)}과 다릅니다")
    message_ids = [msg["supplier_id"] for msg in detail["order_messages"]]
    if sorted(message_ids) != sorted(goods):
        problems.append(f"{key}: 주문 문구의 거래처 {message_ids}가 주문한 거래처 {sorted(goods)}와 다릅니다")
    for row in detail["stock_after"]:
        item = items[row["item_id"]]
        after = item["usable_inventory"] + bought[row["item_id"]]
        if abs(row["after_delivery"] - after) > EPS or abs(row["end_of_period"] - (after - item["gross_need"])) > EPS:
            problems.append(f"{key}: {row['item_id']} 입고 후·기간 끝 재고 숫자가 맞지 않습니다")
    for msg in detail["order_messages"]:
        g = goods.get(msg["supplier_id"])
        if g is None or f"{_supplier_cost(suppliers[msg['supplier_id']], g):,}원" not in msg["text"]:
            problems.append(f"{key}: {msg['supplier_id']} 주문 문구의 금액이 맞지 않습니다")
    return problems
