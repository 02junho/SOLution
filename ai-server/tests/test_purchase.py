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


def test_구매_목록_줄마다_품목과_거래처_이름이_있다():
    """화면이 입력을 다시 찾지 못해도 이름을 보여 줄 수 있게 줄마다 이름을 넣는다 (#80)."""
    data = _post(REQUEST).json()["data"]
    item_names = {i["item_id"]: i["item_name"] for i in REQUEST["items"]}
    supplier_names = {s["supplier_id"]: s["supplier_name"] for s in REQUEST["suppliers"]}
    lines = [line for c in data["detail"]["choices"] for line in c["lines"]] + data["detail"]["baseline"]["lines"]

    assert lines
    for line in lines:
        assert line["item_name"] == item_names[line["item_id"]]
        assert line["supplier_name"] == supplier_names[line["supplier_id"]]
    first = data["detail"]["choices"][0]["lines"][0]
    assert (first["supplier_id"], first["supplier_name"], first["item_id"], first["item_name"]) == ("A", "거래처 A", "beans", "원두")


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


def test_기간_끝_재고_한도에_딱_맞으면_그대로():
    body = _req()
    body["items"][1]["max_end_inventory"] = 5000  # 안 1 우유: 8,000 + 18,000 − 21,000 = 5,000

    data = _post(body).json()["data"]

    assert _choices(data)["purchase_1"]["total_krw"] == 120400
    assert _choices(data)["purchase_1"]["constraints_met"]["spoilage"] is True
    milk = next(b for b in data["detail"]["buy_needs"] if b["item_id"] == "milk")
    assert milk["max_end_inventory"] == 5000
    # 기준선은 우유 12L × 2 → 기간 끝 11,000이 남아 한도를 넘는다.
    assert "spoilage" in data["detail"]["baseline"]["constraint_violations"]
    # 안 2(전부 거래처 A)는 A가 우유를 12L로만 팔아 기간 끝에 11,000이 남으므로 만들 수 없다.
    assert _choices(data)["purchase_2"] == {
        "choice_key": "purchase_2", "label": "배송 1회", "available": False, "same_as": None,
        "unavailable_reason": "배송 1회로 사면 기간 끝에 너무 많이 남아요.",
    }


def test_기간_끝에_너무_많이_남으면_infeasible():
    body = _req()
    body["items"][1]["max_end_inventory"] = 4000  # 우유는 15,000~17,000 사이로 사야 하는데 12L·6L로는 못 맞춘다

    payload = _post(body).json()

    assert payload["status"] == "infeasible"
    assert payload["data"]["violations"] == [{"constraint": "spoilage", "label": "기간 끝 재고 한도", "item_ids": ["milk"]}]
    assert payload["data"]["suggestions"] == ["더 작은 포장 견적을 추가하거나 기간 끝 재고 한도를 늘리기"]
    assert payload["message"] == "기간 끝 재고 한도 조건 때문에 필요한 양을 살 수 없어요."


def test_작은_포장이_있으면_기간_끝_재고_한도를_지킨다():
    body = _req()
    body["items"][1]["max_end_inventory"] = 4000
    body["quotes"].append(
        {"supplier_id": "B", "item_id": "milk", "pack_size": 1000, "pack_unit": "ml", "pack_price_krw": 3000, "vat_included": True}
    )

    data = _post(body).json()["data"]

    detail = next(c for c in data["detail"]["choices"] if c["choice_key"] == "purchase_1")
    milk = next(s for s in detail["stock_after"] if s["item_id"] == "milk")
    assert 15000 <= milk["bought"] <= 17000
    assert milk["end_of_period"] <= 4000


def test_지금_재고만으로_기간_끝_한도를_넘으면_사지_않고_경고한다():
    body = _req()
    body["items"][1].update(gross_need=1000, usable_inventory=8000, safety_stock=0, max_end_inventory=5000)

    data = _post(body).json()["data"]

    choice = _choices(data)["purchase_1"]
    assert choice["constraints_met"]["spoilage"] is False
    assert "END_STOCK_OVER_LIMIT" in choice["warning_ids"]
    warning = next(w for w in data["summary"]["warnings"] if w["warning_id"] == "END_STOCK_OVER_LIMIT")
    assert warning["requires_ack"] is False
    assert warning["message"].startswith("우유은(는) 사지 않아도 기간 끝에 7,000ml가 남아 한도 5,000ml를 넘어요")
    detail = next(c for c in data["detail"]["choices"] if c["choice_key"] == "purchase_1")
    assert all(line["item_id"] != "milk" for line in detail["lines"])


def test_소수_수량도_포장_단위로_딱_맞게_산다():
    body = _req(quotes=[
        {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "vat_included": True},
        {"supplier_id": "B", "item_id": "milk", "pack_size": 0.1, "pack_unit": "ml", "pack_price_krw": 1000, "vat_included": True},
    ])
    body["suppliers"][1]["minimum_order_krw"] = 0
    body["items"][1].update(gross_need=0.7, usable_inventory=0, safety_stock=0, storage_capacity=None, max_end_inventory=0)

    payload = _post(body).json()

    assert payload["status"] == "ok"  # 0.7 / 0.1 = 6.999… 이어도 7묶음까지 살 수 있어야 한다
    detail = next(c for c in payload["data"]["detail"]["choices"] if c["choice_key"] == "purchase_1")
    milk = next(line for line in detail["lines"] if line["item_id"] == "milk")
    assert milk["pack_count"] == 7


def test_조건_세_개를_함께_풀어야_하면_그_세_개만_원인으로_알려준다():
    body = _req(
        max_delivery_count=1,
        items=[
            {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 1, "usable_inventory": 0, "safety_stock": 0, "max_end_inventory": 0},
            {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 1, "usable_inventory": 0, "safety_stock": 0, "storage_capacity": 1},
        ],
        quotes=[
            {"supplier_id": "A", "item_id": "beans", "pack_size": 2, "pack_unit": "g", "pack_price_krw": 100, "vat_included": True},
            {"supplier_id": "B", "item_id": "milk", "pack_size": 2, "pack_unit": "ml", "pack_price_krw": 100, "vat_included": True},
        ],
    )
    for s in body["suppliers"]:
        s["minimum_order_krw"] = 0

    payload = _post(body).json()

    assert payload["status"] == "infeasible"
    assert sorted(v["constraint"] for v in payload["data"]["violations"]) == ["delivery_count", "spoilage", "storage"]


def test_기간_끝_재고_한도가_안전재고보다_작으면_400():
    body = _req()
    body["items"][1]["max_end_inventory"] = 1000  # 안전재고 2,000

    response = _post(body)

    assert response.status_code == 400
    assert "안전재고" in response.json()["message"]


def test_견적이_없는_품목():
    body = _req()
    body["items"].append(
        {"item_id": "syrup", "item_name": "시럽", "base_unit": "ml", "gross_need": 1000, "usable_inventory": 0, "safety_stock": 0}
    )

    payload = _post(body).json()

    assert payload["status"] == "infeasible"
    assert payload["data"]["violations"] == [{"constraint": "no_quote", "label": "견적이 없는 품목", "item_ids": ["syrup"]}]
    assert payload["message"] == "시럽 견적이 없어서 구매안을 만들 수 없어요."
    assert payload["data"]["suggested_changes"] == []  # 칸을 바꿔서는 못 고치고 견적을 넣어야 한다


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


# ── 덜 채운 입력: 빈 칸은 400이 아니라 needs_input ─────────────────


def test_예산과_견적이_아직_없으면_빈_칸을_묻는다(tool_logs):
    body = _req()
    del body["budget_krw"]
    body["quotes"] = []

    response = _post(body)

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "needs_input"
    assert payload["data"]["detail_status"] == "NEEDS_INPUT"
    assert payload["data"]["missing_fields"] == [
        {"path": "budget_krw", "label": "예산", "unit": None},
        {"path": "quotes", "label": "견적", "unit": None},
    ]
    assert payload["message"] == "계산하려면 예산, 견적이 필요해요."
    assert tool_logs[0]["status"] == "incomplete"
    assert tool_logs[0]["session_id"] == REQUEST["session_id"]


def test_품목_칸이_null이면_품목_이름과_단위로_묻는다():
    body = _req()
    body["items"][1]["gross_need"] = None

    payload = _post(body).json()

    assert payload["status"] == "needs_input"
    assert payload["data"]["missing_fields"] == [
        {"path": "items[1].gross_need", "label": "우유 필요량", "unit": "ml", "item_id": "milk"}
    ]
    assert payload["message"] == "계산하려면 우유 필요량이 필요해요."


def test_다른_빈_칸과_재고_빈칸을_한_번에_묻는다():
    body = _req()
    body["items"][0]["usable_inventory"] = None
    del body["suppliers"][0]["delivery_fee_krw"]

    paths = [f["path"] for f in _post(body).json()["data"]["missing_fields"]]

    assert paths == ["items[0].usable_inventory", "suppliers[0].delivery_fee_krw"]


def test_견적_칸이_비면_거래처와_품목_이름으로_묻는다():
    body = _req()
    del body["quotes"][0]["pack_price_krw"]

    field = _post(body).json()["data"]["missing_fields"][0]

    assert field["path"] == "quotes[0].pack_price_krw"
    assert field["label"].endswith("견적 묶음 가격")
    assert "원두" in field["label"]


def test_부가세_칸이_없으면_모름으로_보고_계산한다():
    body = _req()
    for q in body["quotes"]:
        del q["vat_included"]

    payload = _post(body).json()

    assert payload["status"] == "ok"
    assert any(w["warning_id"] == "VAT_UNKNOWN" for w in payload["data"]["summary"]["warnings"])


def test_숫자_칸이_빈_문자열이어도_빈_칸으로_묻는다():
    body = _req(budget_krw="")
    body["quotes"][0]["pack_price_krw"] = "  "

    payload = _post(body).json()

    assert payload["status"] == "needs_input"
    assert [f["path"] for f in payload["data"]["missing_fields"]] == ["budget_krw", "quotes[0].pack_price_krw"]


def test_숫자_칸에_숫자가_아닌_글자는_400():
    assert _post(_req(budget_krw="많이")).status_code == 400


def test_빈_칸과_틀린_값이_섞이면_400():
    body = _req()
    del body["budget_krw"]
    body["quotes"][0]["pack_price_krw"] = -1

    assert _post(body).status_code == 400


def test_Spring이_넣는_칸이_비면_400():
    body = _req()
    del body["input_version_id"]

    response = _post(body)

    assert response.status_code == 400
    assert response.json()["status"] == "error"


# ── 조건 수정 후 재계산: 실패 응답의 suggested_changes ─────────────────


def _apply(body: dict, changes: list[dict]) -> dict:
    """suggested_changes의 path(예: budget_krw, items[1].storage_capacity)대로 값을 바꾼 새 요청."""
    new = copy.deepcopy(body)
    for c in changes:
        target, key = new, c["path"]
        if key.startswith("items["):
            index, key = key[len("items["):].split("].")
            target = new["items"][int(index)]
        assert target[key] == c["current"]
        target[key] = c["suggested"]
    return new


def _three_conditions_request() -> dict:
    body = _req(
        max_delivery_count=1,
        items=[
            {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 1, "usable_inventory": 0, "safety_stock": 0, "max_end_inventory": 0},
            {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 1, "usable_inventory": 0, "safety_stock": 0, "storage_capacity": 1},
        ],
        quotes=[
            {"supplier_id": "A", "item_id": "beans", "pack_size": 2, "pack_unit": "g", "pack_price_krw": 100, "vat_included": True},
            {"supplier_id": "B", "item_id": "milk", "pack_size": 2, "pack_unit": "ml", "pack_price_krw": 100, "vat_included": True},
        ],
    )
    for s in body["suppliers"]:
        s["minimum_order_krw"] = 0
    return body


def test_예산_부족이면_예산을_얼마로_바꿀지_알려준다():
    data = _post(_req(budget_krw=100000)).json()["data"]

    assert data["suggested_changes"] == [
        {"path": "budget_krw", "label": "예산", "unit": "원", "current": 100000, "suggested": 120400}
    ]


def test_조건_세_개가_원인이면_세_칸을_모두_알려준다():
    data = _post(_three_conditions_request()).json()["data"]

    assert [c["path"] for c in data["suggested_changes"]] == [
        "max_delivery_count", "items[0].max_end_inventory", "items[1].storage_capacity"
    ]
    # 배송 2회, 원두는 2g 한 봉을 사서 1g이 남음, 우유는 2ml 한 팩이 들어감
    assert [c["suggested"] for c in data["suggested_changes"]] == [2, 1, 2]


def test_최소_주문금액이_원인이면_바꿀_칸을_제안하지_않는다():
    body = _req()
    for s in body["suppliers"]:
        s["minimum_order_krw"] = 500000  # 예산보다 커서 어느 거래처도 최소 주문금액을 못 채운다

    data = _post(body).json()["data"]

    assert "minimum_order" in [v["constraint"] for v in data["violations"]]
    assert data["suggested_changes"] == []


def test_제안대로_바꿔_다시_계산하면_구매안이_나온다():
    def spoiled(body):
        body["items"][1]["max_end_inventory"] = 4000
        return body

    def stored(body):
        body["items"][0]["storage_capacity"] = 2500
        return body

    cases = {
        "예산": _req(budget_krw=100000),
        "배송 횟수": _req(max_delivery_count=1, quotes=[q for q in REQUEST["quotes"] if not (q["supplier_id"] == "A" and q["item_id"] == "milk")]),
        "보관 한도": stored(_req()),
        "기간 끝 재고 한도": spoiled(_req()),
        "세 조건": _three_conditions_request(),
    }
    for name, body in cases.items():
        first = _post(body).json()
        assert first["status"] == "infeasible", name
        changes = first["data"]["suggested_changes"]
        assert changes, name

        again = _post(_apply(body, changes)).json()

        assert again["status"] == "ok", (name, again["message"])
