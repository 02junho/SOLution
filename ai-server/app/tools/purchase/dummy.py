"""11.15 더미 연결용 고정 응답. 실제 계산(PuLP)으로 바꾸기 전까지 화면·Spring 연결을 확인하는 데 쓴다.

숫자는 노션 API 명세서 "구매 최적화"의 요청 예시(원두·우유, 거래처 A·B)를 손으로 계산한 값이다.
원두는 원두 예제(URQ-PUR-001 첫 테스트 정답)와 같다: 살 양 2,200g → 1kg 3봉 → 입고 직후 4,000g → 기간 끝 1,300g.
요청 값과 상관없이 같은 결과를 돌려주며, assumptions에 더미라고 적는다.
"""

DUMMY_NOTE = "더미 응답 (11.15 연결 확인용, 실제 계산 아님)"

_A = {"supplier_id": "A", "supplier_name": "거래처 A"}
_B = {"supplier_id": "B", "supplier_name": "거래처 B"}

DUMMY_OK_DATA: dict = {
    "detail_status": "OPTIMAL",
    "summary": {
        "choices": [
            {
                "choice_key": "purchase_1",
                "label": "총비용 최소",
                "available": True,
                "same_as": None,
                "total_krw": 120400,
                "goods_krw": 114400,
                "delivery_fee_krw": 6000,
                "delivery_count": 2,
                "supplier_totals": [
                    {**_A, "goods_krw": 66000, "delivery_fee_krw": 3000},
                    {**_B, "goods_krw": 48400, "delivery_fee_krw": 3000},
                ],
                "diff_from_baseline_krw": -15400,
                "constraints_met": {"budget": True, "minimum_order": True, "storage": True, "delivery_count": True},
                "warning_ids": ["VAT_UNKNOWN"],
            },
            {
                "choice_key": "purchase_2",
                "label": "배송 1회",
                "available": True,
                "same_as": None,
                "total_krw": 138000,
                "goods_krw": 135000,
                "delivery_fee_krw": 3000,
                "delivery_count": 1,
                "supplier_totals": [
                    {**_A, "goods_krw": 135000, "delivery_fee_krw": 3000},
                ],
                "diff_from_baseline_krw": 2200,
                "constraints_met": {"budget": True, "minimum_order": True, "storage": True, "delivery_count": True},
                "warning_ids": [],
            },
        ],
        "baseline": {"label": "단위단가순 담기 (비교용)", "total_krw": 135800, "confirmable": False},
        "warnings": [
            {
                "warning_id": "VAT_UNKNOWN",
                "requires_ack": True,
                "choice_keys": ["purchase_1"],
                "message": "거래처 B 우유(6팩)는 부가세 포함 여부를 모릅니다. 총액이 달라질 수 있어요.",
            }
        ],
        "assumptions": ["거래처 1곳 = 배송 1회", DUMMY_NOTE],
    },
    "detail": {
        "buy_needs": [
            {"item_id": "beans", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "buy_need": 2200},
            {"item_id": "milk", "base_unit": "ml", "gross_need": 21000, "usable_inventory": 8000, "safety_stock": 2000, "buy_need": 15000},
        ],
        "choices": [
            {
                "choice_key": "purchase_1",
                "lines": [
                    {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "pack_count": 3, "line_krw": 66000, "vat_included": True},
                    {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 31900, "pack_count": 1, "line_krw": 31900, "vat_included": True},
                    {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "pack_count": 1, "line_krw": 16500, "vat_included": None},
                ],
                "stock_after": [
                    {"item_id": "beans", "bought": 3000, "after_delivery": 4000, "end_of_period": 1300},
                    {"item_id": "milk", "bought": 18000, "after_delivery": 26000, "end_of_period": 5000},
                ],
                "order_messages": [
                    {"supplier_id": "A", "text": "안녕하세요. 아래와 같이 주문 부탁드립니다.\n- 원두 1kg × 3봉\n상품 66,000원 + 배송비 3,000원 = 69,000원\n확인 부탁드립니다."},
                    {"supplier_id": "B", "text": "안녕하세요. 아래와 같이 주문 부탁드립니다.\n- 우유 1L×12팩 × 1개\n- 우유 1L×6팩 × 1개\n상품 48,400원 + 배송비 3,000원 = 51,400원\n확인 부탁드립니다."},
                ],
            },
            {
                "choice_key": "purchase_2",
                "lines": [
                    {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "pack_count": 3, "line_krw": 66000, "vat_included": True},
                    {"supplier_id": "A", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34500, "pack_count": 2, "line_krw": 69000, "vat_included": True},
                ],
                "stock_after": [
                    {"item_id": "beans", "bought": 3000, "after_delivery": 4000, "end_of_period": 1300},
                    {"item_id": "milk", "bought": 24000, "after_delivery": 32000, "end_of_period": 11000},
                ],
                "order_messages": [
                    {"supplier_id": "A", "text": "안녕하세요. 아래와 같이 주문 부탁드립니다.\n- 원두 1kg × 3봉\n- 우유 1L×12팩 × 2개\n상품 135,000원 + 배송비 3,000원 = 138,000원\n확인 부탁드립니다."},
                ],
            },
        ],
        "baseline": {
            "method": "품목마다 단위가격이 가장 싼 견적을 골라 필요량만큼 올림",
            "lines": [
                {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_count": 3, "line_krw": 66000},
                {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_count": 2, "line_krw": 63800},
            ],
            "total_krw": 135800,
            "constraint_violations": [],
        },
    },
}
