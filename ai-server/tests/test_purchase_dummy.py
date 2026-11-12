"""POST /tools/purchase 더미 응답 검사. 노션 API 명세서 "구매 최적화"의 요청 예시를 그대로 쓴다."""

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


def _post(body: dict, headers: dict | None = None):
    return client.post("/tools/purchase", json=body, headers=headers or {})


def test_구매안_2개를_공통_응답으로_돌려준다():
    response = _post(REQUEST, {"X-Request-Key": "key-1"})

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["data"]["detail_status"] == "OPTIMAL"
    keys = [c["choice_key"] for c in body["data"]["summary"]["choices"]]
    assert keys == ["purchase_1", "purchase_2"]
    assert body["data"]["summary"]["baseline"]["confirmable"] is False


def test_더미_숫자가_서로_맞는다():
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
        for line in lines:
            assert line["line_krw"] == line["pack_price_krw"] * line["pack_count"]


def test_원두는_원두_예제_정답과_같다():
    data = _post(REQUEST).json()["data"]
    beans_need = next(n for n in data["detail"]["buy_needs"] if n["item_id"] == "beans")
    assert beans_need["buy_need"] == 2700 - 1000 + 500 == 2200

    for choice in data["detail"]["choices"]:
        beans = next(s for s in choice["stock_after"] if s["item_id"] == "beans")
        assert (beans["bought"], beans["after_delivery"], beans["end_of_period"]) == (3000, 4000, 1300)


def test_부가세_모르는_견적은_경고가_붙는다():
    data = _post(REQUEST).json()["data"]
    warning = data["summary"]["warnings"][0]
    assert warning["warning_id"] == "VAT_UNKNOWN"
    assert warning["requires_ack"] is True


def test_더미라고_표시한다():
    assumptions = _post(REQUEST).json()["data"]["summary"]["assumptions"]
    assert any("더미" in a for a in assumptions)


def test_재고가_빈칸이면_needs_input():
    body = copy.deepcopy(REQUEST)
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


def test_재고_칸을_아예_빼면_400():
    body = copy.deepcopy(REQUEST)
    del body["items"][0]["usable_inventory"]

    response = _post(body)

    assert response.status_code == 400
    assert response.json()["status"] == "error"


def test_음수_가격은_400():
    body = copy.deepcopy(REQUEST)
    body["quotes"][0]["pack_price_krw"] = -1

    response = _post(body)

    assert response.status_code == 400
    assert "pack_price_krw" in response.json()["message"]


def test_단위는_g_ml_ea만_받는다():
    body = copy.deepcopy(REQUEST)
    body["items"][0]["base_unit"] = "kg"

    assert _post(body).status_code == 400


def test_응답은_매번_새로_복사된다():
    first = _post(REQUEST).json()["data"]
    first["summary"]["choices"].clear()
    assert len(_post(REQUEST).json()["data"]["summary"]["choices"]) == 2
