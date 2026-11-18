"""구매 최적화 평가 사례. 정답은 앱 코드가 아닌 곳에서 왔다 (출처를 사례마다 적는다).

expect 키
- status: ok / infeasible / needs_input / error
- p1, p2: 안 1·안 2 총액. p2는 "same"(안 1과 같음) 또는 "unavailable"(배송 1회 불가)일 수 있다
- baseline: 기준선 총액, baseline_violations: 기준선이 어긴 조건
- violations: infeasible일 때 원인 조건
- oracle: True면 독립 전수 열거 정답과도 비교한다
"""

from __future__ import annotations

import copy
import random

# ── 명세 예시 (노션·드라이브 API 명세, 11.12 손계산) ─────────────────────
SPEC = {
    "store_id": 1, "session_id": 100, "input_version_id": 1001,
    "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
    "items": [
        {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
        {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 21000, "usable_inventory": 8000, "safety_stock": 2000, "storage_capacity": 40000},
    ],
    "suppliers": [
        {"supplier_id": "A", "supplier_name": "거래처 A", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": None},
        {"supplier_id": "B", "supplier_name": "거래처 B", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": None},
    ],
    "quotes": [
        {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "vat_included": True},
        {"supplier_id": "A", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34500, "vat_included": True},
        {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 31900, "vat_included": True},
        {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "vat_included": None},
    ],
}

# ── 방현식 10.26 조사 묶음의 합성 사례 (구현자와 다른 사람이 낸 블라인드 정답) ──
# 원본 request_base.json을 지금 요청 형식으로 옮김. 안전재고 0, 무료배송 없음.
_HS_ITEMS = [("milk", "우유", "ml", 5000, 1000, 7000), ("beans", "원두", "g", 1000, 200, 1400),
             ("syrup", "시럽", "ml", 1000, 0, 1500), ("tomato", "토마토", "g", 2000, 500, 3000),
             ("lettuce", "양상추", "g", 1000, 0, 2000)]
_HS_QUOTES = [("A", "milk", 1000, 2200), ("B", "milk", 1000, 2500), ("A", "beans", 500, 8000),
              ("B", "beans", 500, 8500), ("A", "syrup", 1000, 5000), ("B", "syrup", 500, 2400),
              ("A", "tomato", 2000, 5300), ("B", "tomato", 500, 1400), ("A", "lettuce", 500, 2000),
              ("B", "lettuce", 500, 2100)]
HS_BASE = {
    "store_id": 1, "session_id": 100, "input_version_id": 1001,
    "planning_days": 7, "budget_krw": 45000, "max_delivery_count": 2,
    "items": [
        {"item_id": i, "item_name": n, "base_unit": u, "gross_need": g, "usable_inventory": inv, "safety_stock": 0, "storage_capacity": cap}
        for i, n, u, g, inv, cap in _HS_ITEMS
    ],
    "suppliers": [
        {"supplier_id": "A", "supplier_name": "거래처 A", "minimum_order_krw": 5000, "delivery_fee_krw": 1000, "free_delivery_min_krw": None},
        {"supplier_id": "B", "supplier_name": "거래처 B", "minimum_order_krw": 4000, "delivery_fee_krw": 1000, "free_delivery_min_krw": None},
    ],
    "quotes": [
        {"supplier_id": s, "item_id": i, "pack_size": size, "pack_unit": dict((x[0], x[2]) for x in _HS_ITEMS)[i], "pack_price_krw": p, "vat_included": True}
        for s, i, size, p in _HS_QUOTES
    ],
}

# ── 시연 자료 (data/demo, 최정경 확인 11.17) · 시연 업무 1004와 같은 입력 ─────
# 총필요량은 판매 계획(아이스 아메리카노 100 · 아이스 라떼 30 · 핫 라떼 20잔) × 재료표로 계산한 값.
# 우유는 재료표대로 핫 라떼 220ml (아이스 라떼 200ml × 30 + 220ml × 20 = 10,400ml). 200ml로 셌을 때(10,000ml)와 구매안은 같다.
DEMO = {
    "store_id": 1, "session_id": 100, "input_version_id": 1001,
    "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
    "items": [
        {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
        {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 10400, "usable_inventory": 2000, "safety_stock": 2000, "storage_capacity": 24000},
        {"item_id": "ice_cup", "item_name": "아이스컵", "base_unit": "ea", "gross_need": 130, "usable_inventory": 50, "safety_stock": 50, "storage_capacity": 1000},
        {"item_id": "hot_cup", "item_name": "핫컵", "base_unit": "ea", "gross_need": 20, "usable_inventory": 30, "safety_stock": 30, "storage_capacity": 500},
        {"item_id": "lid", "item_name": "컵 뚜껑", "base_unit": "ea", "gross_need": 150, "usable_inventory": 100, "safety_stock": 50, "storage_capacity": 1000},
    ],
    "suppliers": [
        {"supplier_id": "A", "supplier_name": "거래처 A (원두 로스터리)", "minimum_order_krw": 70000, "delivery_fee_krw": 3000, "free_delivery_min_krw": None},
        {"supplier_id": "B", "supplier_name": "거래처 B (유제품 대리점)", "minimum_order_krw": 20000, "delivery_fee_krw": 4000, "free_delivery_min_krw": 50000},
        {"supplier_id": "C", "supplier_name": "거래처 C (카페 도매몰)", "minimum_order_krw": 0, "delivery_fee_krw": 5000, "free_delivery_min_krw": 150000},
        {"supplier_id": "D", "supplier_name": "거래처 D (동네 식자재마트)", "minimum_order_krw": 0, "delivery_fee_krw": 2000, "free_delivery_min_krw": None},
    ],
    "quotes": [
        {"supplier_id": s, "item_id": i, "pack_size": size, "pack_unit": u, "pack_price_krw": p, "vat_included": v}
        for s, i, size, u, p, v in [
            ("A", "beans", 1000, "g", 20000, True), ("B", "milk", 12000, "ml", 28000, True),
            ("B", "milk", 6000, "ml", 16500, None), ("C", "beans", 1000, "g", 23000, True),
            ("C", "milk", 12000, "ml", 34000, True), ("C", "ice_cup", 50, "ea", 4000, True),
            ("C", "hot_cup", 50, "ea", 4500, True), ("C", "lid", 100, "ea", 3000, True),
            ("D", "beans", 1000, "g", 26000, True), ("D", "milk", 6000, "ml", 19800, True),
            ("D", "ice_cup", 50, "ea", 5000, True), ("D", "hot_cup", 50, "ea", 5500, True),
            ("D", "lid", 100, "ea", 3500, True),
        ]
    ],
}


# ── 거래처 12곳 시연 자료 (data/demo/expanded, 최정경 확인 11.18) · 시연 업무 1005와 같은 입력 ─────
# 품목·재고·판매 계획은 1004(DEMO)와 같고 거래처·견적만 늘렸다. 값마다 근거는 드라이브 「시연 자료 확인 요청 2」.
EXPANDED = {
    "store_id": 1, "session_id": 100, "input_version_id": 1001,
    "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
    "items": copy.deepcopy(DEMO["items"]),
    "suppliers": [
        {"supplier_id": s, "supplier_name": n, "minimum_order_krw": mo, "delivery_fee_krw": fee, "free_delivery_min_krw": free}
        for s, n, mo, fee, free in [
            ("R1", "원두 로스터리 가 (대량 납품)", 76000, 2900, 78800),
            ("R2", "원두 로스터리 나 (일반 납품)", 0, 3000, 50000),
            ("R3", "원두 로스터리 다 (소분 판매)", 0, 3000, None),
            ("M1", "유제품 대리점 가 (지역 직배송)", 0, 0, None),
            ("M2", "유제품 대리점 나 (낱개 판매)", 0, 3000, 30000),
            ("M3", "유제품 대리점 다 (6개 묶음)", 0, 4000, 50000),
            ("P1", "포장재 도매 가 (박스 단위)", 0, 0, None),
            ("P2", "포장재 도매 나 (100개 묶음)", 0, 3000, 50000),
            ("P3", "포장재 소매 다 (50개 낱줄)", 0, 3000, None),
            ("C", "카페 도매몰", 0, 5000, 150000),
            ("D", "동네 식자재마트", 0, 2000, None),
            ("G", "온라인 대형몰", 0, 3000, 19800),
        ]
    ],
    "quotes": [
        {"supplier_id": s, "item_id": i, "pack_size": size, "pack_unit": u, "pack_price_krw": p, "vat_included": v}
        for s, i, size, u, p, v in [
            ("R1", "beans", 1000, "g", 19000, True),
            ("R2", "beans", 1000, "g", 25000, True),
            ("R3", "beans", 1000, "g", 22700, True),
            ("R3", "beans", 500, "g", 14800, True),
            ("M1", "milk", 12000, "ml", 21600, True),
            ("M2", "milk", 1000, "ml", 2050, True),
            ("M3", "milk", 6000, "ml", 11100, None),
            ("P1", "ice_cup", 1000, "ea", 48900, True),
            ("P1", "hot_cup", 1000, "ea", 30900, True),
            ("P1", "lid", 1000, "ea", 19620, True),
            ("P2", "ice_cup", 100, "ea", 5500, True),
            ("P2", "hot_cup", 100, "ea", 3200, True),
            ("P2", "lid", 100, "ea", 1790, True),
            ("P3", "ice_cup", 50, "ea", 3100, True),
            ("P3", "hot_cup", 50, "ea", 1650, True),
            ("P3", "lid", 50, "ea", 1170, True),
            ("C", "beans", 1000, "g", 23000, True),
            ("C", "milk", 12000, "ml", 34000, True),
            ("C", "ice_cup", 50, "ea", 4000, True),
            ("C", "hot_cup", 50, "ea", 4500, True),
            ("C", "lid", 100, "ea", 3000, True),
            ("D", "beans", 1000, "g", 26000, True),
            ("D", "milk", 6000, "ml", 19800, True),
            ("D", "ice_cup", 50, "ea", 5000, True),
            ("D", "hot_cup", 50, "ea", 5500, True),
            ("D", "lid", 100, "ea", 3500, True),
            ("G", "beans", 1000, "g", 27000, True),
            ("G", "milk", 12000, "ml", 32890, True),
            ("G", "ice_cup", 100, "ea", 6100, True),
            ("G", "hot_cup", 100, "ea", 3200, True),
            ("G", "lid", 100, "ea", 1790, True),
        ]
    ],
}

def _with(base: dict, fn) -> dict:
    req = copy.deepcopy(base)
    fn(req)
    return req


def named_cases() -> list[dict]:
    return [
        {"id": "E01", "name": "명세 예시 (품목 2 · 거래처 2)", "source": "API 명세 손계산 (11.12)", "request": SPEC,
         "expect": {"status": "ok", "p1": 120400, "p2": 138000, "baseline": 135800, "baseline_violations": []}},
        {"id": "E02", "name": "현식 합성 사례 (품목 5 · 거래처 2)", "source": "방현식 블라인드 정답 (10.26)", "request": HS_BASE,
         "expect": {"status": "ok", "p1": 39800, "p2": 40100, "baseline": 40900, "baseline_violations": [], "oracle": True}},
        {"id": "E03", "name": "현식 사례 · 배송 한도 1", "source": "방현식 블라인드 정답 (10.26)",
         "request": _with(HS_BASE, lambda r: r.update(max_delivery_count=1)),
         "expect": {"status": "ok", "p1": 40100, "p2": "same", "baseline": 40900, "baseline_violations": ["delivery_count"], "oracle": True}},
        {"id": "E04", "name": "현식 사례 · 예산이 최적 금액과 같음", "source": "방현식 블라인드 정답 (10.26)",
         "request": _with(HS_BASE, lambda r: r.update(budget_krw=39800)),
         "expect": {"status": "ok", "p1": 39800, "p2": "unavailable", "baseline": 40900, "baseline_violations": ["budget"], "oracle": True}},
        {"id": "E05", "name": "현식 사례 · 예산 1원 부족", "source": "방현식 블라인드 정답 (10.26)",
         "request": _with(HS_BASE, lambda r: r.update(budget_krw=39799)),
         "expect": {"status": "infeasible", "violations": ["budget"], "oracle": True}},
        {"id": "E13", "name": "현식 사례 · 토마토 보관 한도 2,000g", "source": "신준호 손계산 (11.16)",
         # 토마토는 재고 500g이라 1,500g까지만 들일 수 있다. 기준선(A 2kg 1봉)은 보관 한도를 넘고, 안 1(B 500g × 3)은 그대로다.
        # 안 2는 A의 2kg 포장을 못 써서 전부 B: 상품 40,200 + 배송 1,000 = 41,200원.
         "request": _with(HS_BASE, lambda r: r["items"][3].update(storage_capacity=2000)),
         "expect": {"status": "ok", "p1": 39800, "p2": 41200, "baseline": 40900, "baseline_violations": ["storage"], "oracle": True}},
        {"id": "E14", "name": "현식 사례 · 토마토 보관 한도 1,999g", "source": "방현식 블라인드 정답 (10.26)",
         "request": _with(HS_BASE, lambda r: r["items"][3].update(storage_capacity=1999)),
         "expect": {"status": "infeasible", "violations": ["storage"], "oracle": True}},
        {"id": "E06", "name": "시연 자료 (품목 5 · 거래처 4, 업무 1004)", "source": "신준호 계산 (11.15), 최정경 자료 확인 (11.17)", "request": DEMO,
         "expect": {"status": "ok", "p1": 125500, "p2": 127500, "baseline": 119500, "baseline_violations": ["delivery_count", "minimum_order"]}},
        {"id": "E18", "name": "시연 자료 (품목 5 · 거래처 12, 업무 1005)", "source": "신준호 계산 (11.17), 최정경 자료 확인 (11.18)", "request": EXPANDED,
         # 안 1: 원두 로스터리 다(1kg × 2 + 500g) + 온라인 대형몰(19,800원 이상 무료배송). 안 2: 카페 도매몰 한 곳(1004와 같음).
         "expect": {"status": "ok", "p1": 113280, "p2": 127500, "baseline": 166090, "baseline_violations": ["delivery_count", "minimum_order", "storage"]}},
        {"id": "E19", "name": "거래처 12곳 · 배송 한도 3회", "source": "신준호 계산 (11.17), 최정경 자료 확인 (11.18)",
         # 배송을 하나 더 쓸 수 있으면 우유는 직배송 대리점(12L 21,600원, 배송비 없음), 컵·뚜껑은 50개 낱줄로 바뀐다.
         "request": _with(EXPANDED, lambda r: r.update(max_delivery_count=3)),
         "expect": {"status": "ok", "p1": 101090, "p2": 127500, "baseline": 166090, "baseline_violations": ["delivery_count", "minimum_order", "storage"]}},
        {"id": "E07", "name": "폐기 조건 · 우유 한도에 딱 맞음", "source": "API 명세 손계산 (11.16)",
         "request": _with(SPEC, lambda r: r["items"][1].update(max_end_inventory=5000)),
         "expect": {"status": "ok", "p1": 120400, "p2": "unavailable", "baseline": 135800, "baseline_violations": ["spoilage"]}},
        {"id": "E08", "name": "폐기 조건 · 포장 단위로 못 맞춤", "source": "API 명세 손계산 (11.16)",
         "request": _with(SPEC, lambda r: r["items"][1].update(max_end_inventory=4000)),
         "expect": {"status": "infeasible", "violations": ["spoilage"]}},
        {"id": "E09", "name": "예산 부족 (명세 예시)", "source": "API 명세 손계산 (11.12)",
         "request": _with(SPEC, lambda r: r.update(budget_krw=100000)),
         "expect": {"status": "infeasible", "violations": ["budget"]}},
        {"id": "E10", "name": "재고 빈칸", "source": "API 명세 (needs_input)",
         "request": _with(SPEC, lambda r: r["items"][1].update(usable_inventory=None)),
         "expect": {"status": "needs_input"}},
        {"id": "E16", "name": "견적이 아직 없음 (폼 입력 중)", "source": "구매 도구 빈 칸 규칙 (11.16)",
         "request": _with(SPEC, lambda r: r.update(quotes=[])),
         "expect": {"status": "needs_input"}},
        {"id": "E17", "name": "예산 칸이 아직 없음", "source": "구매 도구 빈 칸 규칙 (11.16)",
         "request": _with(SPEC, lambda r: r.pop("budget_krw")),
         "expect": {"status": "needs_input"}},
        {"id": "E11", "name": "견적 단위가 품목 단위와 다름", "source": "API 명세 (400)",
         "request": _with(SPEC, lambda r: r["quotes"][0].update(pack_unit="ml")),
         "expect": {"status": "error"}},
        {"id": "E12", "name": "기간 끝 재고 한도 < 안전재고", "source": "API 명세 (400)",
         "request": _with(SPEC, lambda r: r["items"][1].update(max_end_inventory=1000)),
         "expect": {"status": "error"}},
    ]


def random_cases(n: int = 30, seed: int = 20261116) -> list[dict]:
    """작은 무작위 사례. 정답은 독립 전수 열거로만 정한다 (expect에 숫자를 적지 않음)."""
    rng = random.Random(seed)
    out = []
    for k in range(n):
        n_sup = rng.choice([2, 3])
        sids = "ABC"[:n_sup]
        items = []
        for iid, unit in (("beans", "g"), ("milk", "ml")):
            gross = rng.choice([1000, 2000, 3000])
            item = {"item_id": iid, "item_name": iid, "base_unit": unit, "gross_need": gross,
                    "usable_inventory": rng.choice([0, 500, 1000]), "safety_stock": rng.choice([0, 500]),
                    "storage_capacity": rng.choice([None, 2500, 4000, 6000])}
            if rng.random() < 0.3:
                item["max_end_inventory"] = item["safety_stock"] + rng.choice([500, 1000, 2000])
            items.append(item)
        suppliers = [
            {"supplier_id": s, "supplier_name": f"거래처 {s}", "minimum_order_krw": rng.choice([0, 5000, 15000]),
             "delivery_fee_krw": rng.choice([0, 2000, 3000]),
             "free_delivery_min_krw": rng.choice([None, None, 20000])}
            for s in sids
        ]
        quotes = []
        for item in items:
            for s in rng.sample(sids, rng.choice([1, 2])):
                size = rng.choice([500, 1000])
                quotes.append({"supplier_id": s, "item_id": item["item_id"], "pack_size": size,
                               "pack_unit": item["base_unit"], "pack_price_krw": rng.randrange(3000, 8001, 100),
                               "vat_included": True})
        req = {"store_id": 1, "session_id": 100, "input_version_id": 1001, "planning_days": 7,
               "budget_krw": rng.choice([20000, 35000, 50000]), "max_delivery_count": rng.choice([1, 2]),
               "items": items, "suppliers": suppliers, "quotes": quotes}
        out.append({"id": f"R{k + 1:02d}", "name": f"무작위 소규모 {k + 1}", "source": f"독립 전수 열거 (seed {seed})",
                    "request": req, "expect": {"oracle": True}})
    return out


def all_cases() -> list[dict]:
    return named_cases() + random_cases()
