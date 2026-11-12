"""POST /tools/purchase 실제 계산 검사. 기본 요청은 노션 API 명세서 "구매 최적화"의 요청 예시 그대로다.

명세 예시의 정답(손계산): 안 1 120,400원(원두 A + 우유 B 12팩·6팩) / 안 2 138,000원(전부 A) / 기준선 135,800원.
"""

import copy

from fastapi.testclient import TestClient

import app.main as main

client = TestClient(main.app)

REQUEST = {
    "store_id": 1,
    "session_id": 100,
    "input_version_id": 1001,
    "planning_days": 7,
    "budget_krw": 200000,
    "max_delivery_count": 2,
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


def _req(**changes) -> dict:
    body = copy.deepcopy(REQUEST)
    body.update(changes)
    return body


def _post(body: dict, headers: dict | None = None):
    return client.post("/tools/purchase", json=body, headers=headers or {})


def _choices(data: dict) -> dict:
    return {c["choice_key"]: c for c in data["summary"]["choices"]}


def _lines(data: dict, key: str) -> list[tuple]:
    detail = next(c for c in data["detail"]["choices"] if c["choice_key"] == key)
    return [(l["supplier_id"], l["item_id"], l["pack_size"], l["pack_count"]) for l in detail["lines"]]


# ── 명세 예시 ─────────────────────────────────────────────


def test_명세_예시_정답과_같다():
    response = _post(REQUEST, {"X-Request-Key": "key-1"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    data = body["data"]
    assert data["detail_status"] == "OPTIMAL"
    c = _choices(data)
    assert (c["purchase_1"]["total_krw"], c["purchase_1"]["goods_krw"], c["purchase_1"]["delivery_fee_krw"]) == (120400, 114400, 6000)
    assert (c["purchase_2"]["total_krw"], c["purchase_2"]["delivery_count"]) == (138000, 1)
    assert data["summary"]["baseline"] == {"label": "단위단가순 담기 (비교용)", "total_krw": 135800, "confirmable": False}
    assert c["purchase_1"]["diff_from_baseline_krw"] == -15400
    assert c["purchase_2"]["diff_from_baseline_krw"] == 2200
    assert _lines(data, "purchase_1") == [("A", "beans", 1000, 3), ("B", "milk", 12000, 1), ("B", "milk", 6000, 1)]
    assert _lines(data, "purchase_2") == [("A", "beans", 1000, 3), ("A", "milk", 12000, 2)]
    assert data["detail"]["baseline"]["constraint_violations"] == []


def test_숫자가_서로_맞는다():
    data = _post(REQUEST).json()["data"]
    baseline_total = data["summary"]["baseline"]["total_krw"]
    details = {c["choice_key"]: c for c in data["detail"]["choices"]}

    for choice in data["summary"]["choices"]:
        assert choice["total_krw"] == choice["goods_krw"] + choice["delivery_fee_krw"]
        assert choice["goods_krw"] == sum(s["goods_krw"] for s in choice["supplier_totals"])
        assert choice["delivery_fee_krw"] == sum(s["delivery_fee_krw"] for s in choice["supplier_totals"])
        assert choice["diff_from_baseline_krw"] == choice["total_krw"] - baseline_total
        assert choice["delivery_count"] == len(choice["supplier_totals"])
        lines = details[choice["choice_key"]]["lines"]
        assert sum(line["line_krw"] for line in lines) == choice["goods_krw"]


def test_원두는_원두_예제_정답과_같다():
    data = _post(REQUEST).json()["data"]
    beans_need = next(n for n in data["detail"]["buy_needs"] if n["item_id"] == "beans")
    assert beans_need["buy_need"] == 2700 - 1000 + 500 == 2200

    for choice in data["detail"]["choices"]:
        beans = next(s for s in choice["stock_after"] if s["item_id"] == "beans")
        assert (beans["bought"], beans["after_delivery"], beans["end_of_period"]) == (3000, 4000, 1300)


def test_부가세_모르는_견적을_쓴_안에만_경고():
    data = _post(REQUEST).json()["data"]
    warning = data["summary"]["warnings"][0]
    assert warning["warning_id"] == "VAT_UNKNOWN"
    assert warning["requires_ack"] is True
    assert warning["choice_keys"] == ["purchase_1"]
    assert "거래처 B 우유(6L)" in warning["message"]
    c = _choices(data)
    assert c["purchase_1"]["warning_ids"] == ["VAT_UNKNOWN"]
    assert c["purchase_2"]["warning_ids"] == []


def test_주문_문구_초안():
    data = _post(REQUEST).json()["data"]
    detail = next(c for c in data["detail"]["choices"] if c["choice_key"] == "purchase_1")
    texts = {m["supplier_id"]: m["text"] for m in detail["order_messages"]}
    assert "- 원두 1kg × 3개" in texts["A"]
    assert "상품 66,000원 + 배송비 3,000원 = 69,000원" in texts["A"]
    assert "- 우유 12L × 1개" in texts["B"] and "- 우유 6L × 1개" in texts["B"]


def test_더미_표시가_없다():
    assumptions = _post(REQUEST).json()["data"]["summary"]["assumptions"]
    assert assumptions == ["거래처 1곳 = 배송 1회"]


def test_같은_입력이면_같은_결과():
    assert _post(REQUEST).json() == _post(REQUEST).json()


def test_실행_기록을_남긴다(tool_logs):
    _post(REQUEST, {"X-Request-Key": "key-9"})

    assert len(tool_logs) == 1
    log = tool_logs[0]
    assert (log["name"], log["session_id"], log["input_version_id"], log["request_key"], log["status"]) == (
        "purchase", 100, 1001, "key-9", "success"
    )
    assert log["payload"] == {"response_status": "ok", "detail_status": "OPTIMAL", "item_count": 2, "supplier_count": 2, "quote_count": 4}


# ── 계산 경계 ─────────────────────────────────────────────


def test_재고가_충분하면_살_것이_없다():
    body = _req()
    for item in body["items"]:
        item["usable_inventory"] = 30000

    data = _post(body).json()["data"]

    c = _choices(data)
    assert c["purchase_1"]["total_krw"] == 0
    assert c["purchase_1"]["delivery_count"] == 0
    assert c["purchase_2"]["same_as"] == "purchase_1"
    assert data["summary"]["baseline"]["total_krw"] == 0


def test_포장_경계는_딱_맞으면_더_사지_않는다():
    body = _req(budget_krw=500000)
    body["items"][0].update(gross_need=2500, usable_inventory=1000, safety_stock=500)  # 살 양 2,000g

    data = _post(body).json()["data"]

    assert ("A", "beans", 1000, 2) in _lines(data, "purchase_1")


def test_최소_주문금액을_못_채우면_다른_거래처로():
    body = _req(max_delivery_count=2)
    body["items"] = [body["items"][1]]
    body["suppliers"][0]["minimum_order_krw"] = 100000  # A에서 12팩 1개(34,500원)만 사면 못 채움
    body["suppliers"][1]["minimum_order_krw"] = 0
    body["quotes"] = [
        {"supplier_id": "A", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 20000, "vat_included": True},
        {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "vat_included": True},
    ]

    data = _post(body).json()["data"]

    # A: 20,000×2 = 40,000 < 100,000이라 못 씀 → B 6팩 3개 49,500 + 배송 3,000
    assert _lines(data, "purchase_1") == [("B", "milk", 6000, 3)]
    assert _choices(data)["purchase_1"]["total_krw"] == 52500
    # 기준선은 단위가격이 싼 A를 고르지만 최소 주문금액을 어긴다.
    assert data["detail"]["baseline"]["constraint_violations"] == ["minimum_order"]


def test_무료배송을_맞추려고_조금_더_산다():
    body = _req()
    body["items"].append(
        {"item_id": "cup", "item_name": "컵", "base_unit": "ea", "gross_need": 0, "usable_inventory": 0, "safety_stock": 0}
    )
    body["suppliers"] = [
        {"supplier_id": "A", "supplier_name": "거래처 A", "minimum_order_krw": 0, "delivery_fee_krw": 5000, "free_delivery_min_krw": 136000},
    ]
    body["quotes"] = [
        body["quotes"][0],
        body["quotes"][1],
        {"supplier_id": "A", "item_id": "cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 600, "vat_included": True},
    ]

    data = _post(body).json()["data"]

    # 원두 66,000 + 우유 69,000 = 135,000 → 배송비 5,000이면 140,000. 컵 2묶음(1,200원)을 더 담으면 무료배송 136,200.
    c = _choices(data)["purchase_1"]
    assert (c["goods_krw"], c["delivery_fee_krw"], c["total_krw"]) == (136200, 0, 136200)
    assert ("A", "cup", 50, 2) in _lines(data, "purchase_1")


def test_배송_1회로_충분하면_안_2는_안_1과_같다():
    data = _post(_req(max_delivery_count=1)).json()["data"]

    c = _choices(data)
    assert c["purchase_1"]["total_krw"] == 138000
    assert c["purchase_2"] == {"choice_key": "purchase_2", "label": "배송 1회", "available": True, "same_as": "purchase_1"}
    assert [d["choice_key"] for d in data["detail"]["choices"]] == ["purchase_1"]


def test_한_거래처에서_다_못_사면_안_2는_없다():
    body = _req()
    del body["quotes"][1]  # A 우유 견적 빼기 → 원두는 A, 우유는 B에만 있음

    data = _post(body).json()["data"]

    c = _choices(data)["purchase_2"]
    assert c["available"] is False
    assert c["unavailable_reason"].startswith("한 거래처에서 모든 품목을 살 수 없어요.")


# ── 답이 없을 때 ─────────────────────────────────────────


def test_예산이_모자라면_최소_필요_금액을_알려준다():
    response = _post(_req(budget_krw=100000))

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "infeasible"
    assert body["data"]["detail_status"] == "INFEASIBLE"
    assert body["data"]["violations"] == [
        {"constraint": "budget", "label": "예산", "budget_krw": 100000, "required_min_krw": 120400}
    ]
    assert body["message"] == "예산 100,000원으로는 필요한 양을 살 수 없어요. 최소 120,400원이 필요해요."
    assert "예산을 120,400원 이상으로 늘리기" in body["data"]["suggestions"]


def test_배송_횟수가_모자라면_infeasible():
    body = _req(max_delivery_count=1)
    del body["quotes"][1]

    payload = _post(body).json()

    assert payload["status"] == "infeasible"
    assert payload["data"]["violations"][0]["constraint"] == "delivery_count"
    assert payload["data"]["violations"][0]["required_min"] == 2
    assert payload["message"] == "배송 1회로는 필요한 양을 살 수 없어요. 최소 2회가 필요해요."


def test_보관_한도를_넘으면_infeasible():
    body = _req()
    body["items"][0]["storage_capacity"] = 2500  # 재고 1,000 + 최소 3,000 > 2,500

    payload = _post(body).json()

    assert payload["status"] == "infeasible"
    assert payload["data"]["violations"] == [{"constraint": "storage", "label": "보관 한도", "item_ids": ["beans"]}]


def test_견적이_없는_품목():
    body = _req()
    body["items"].append(
        {"item_id": "syrup", "item_name": "시럽", "base_unit": "ml", "gross_need": 1000, "usable_inventory": 0, "safety_stock": 0}
    )

    payload = _post(body).json()

    assert payload["status"] == "infeasible"
    assert payload["data"]["violations"] == [{"constraint": "no_quote", "label": "견적이 없는 품목", "item_ids": ["syrup"]}]
    assert payload["message"] == "시럽 견적이 없어서 구매안을 만들 수 없어요."


# ── 입력 확인 ─────────────────────────────────────────────


def test_재고가_빈칸이면_needs_input(tool_logs):
    body = _req()
    body["items"][1]["usable_inventory"] = None

    response = _post(body)

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "needs_input"
    assert payload["data"]["detail_status"] == "NEEDS_INPUT"
    assert payload["data"]["missing_fields"] == [
        {"path": "items[1].usable_inventory", "item_id": "milk", "label": "우유 재고", "unit": "ml"}
    ]
    assert payload["message"] == "우유 재고가 지금 얼마나 있나요?"
    assert tool_logs[0]["status"] == "incomplete"


def test_견적_단위가_품목_단위와_다르면_400():
    body = _req()
    body["quotes"][0]["pack_unit"] = "ml"

    response = _post(body)

    assert response.status_code == 400
    assert response.json()["status"] == "error"
    assert "단위" in response.json()["message"]


def test_없는_거래처_견적은_400():
    body = _req()
    body["quotes"][0]["supplier_id"] = "Z"

    assert _post(body).status_code == 400


def test_재고_칸을_아예_빼도_needs_input():
    body = _req()
    del body["items"][0]["usable_inventory"]

    response = _post(body)

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "needs_input"
    assert payload["data"]["missing_fields"] == [
        {"path": "items[0].usable_inventory", "item_id": "beans", "label": "원두 재고", "unit": "g"}
    ]
    assert payload["message"] == "원두 재고가 지금 얼마나 있나요?"


def test_음수_가격은_400():
    body = _req()
    body["quotes"][0]["pack_price_krw"] = -1

    response = _post(body)

    assert response.status_code == 400
    assert "pack_price_krw" in response.json()["message"]


def test_단위는_g_ml_ea만_받는다():
    body = _req()
    body["items"][0]["base_unit"] = "kg"

    assert _post(body).status_code == 400
