import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from app.quote_test_app import app


class ToolsTest(unittest.TestCase):
    client = TestClient(app)

    def test_pack_and_vat_warning(self):
        payload = {"store_id": "demo", "dictionary_version": 1, "use_rag": False,
                   "dictionary": [{"item_id": "milk", "name": "우유", "base_unit": "ml"}],
                   "items": [{"source_text": "우유 1L 12개입 한 박스 29,000원",
                              "raw_item_name": "우유", "supplier_name": "A",
                              "quantity_per_unit": 1, "quantity_unit": "L",
                              "units_per_pack": 12, "order_unit": "box",
                              "price": 29000, "price_basis": "per_pack"},
                             {"source_text": "우유 한 박스 29,000원", "raw_item_name": "우유",
                              "supplier_name": "A", "order_unit": "box",
                              "price": 29000, "price_basis": "per_pack"}]}
        response = self.client.post("/tools/quote/normalize", json=payload)
        self.assertEqual(response.status_code, 200)
        complete, incomplete = response.json()["items"]
        self.assertEqual(complete["normalized_quantity_per_pack"], 12000)
        self.assertTrue(complete["comparable"])
        self.assertEqual(complete["issues"][0]["code"], "VAT_UNKNOWN")
        self.assertFalse(incomplete["comparable"])
        self.assertIsNone(incomplete["normalized_quantity_per_pack"])

    def _rag_normalize(self, hits):
        payload = {"store_id": "1", "dictionary_version": 1, "use_rag": True,
                   "dictionary": [{"item_id": "milk", "name": "우유", "base_unit": "ml"},
                                  {"item_id": "oat", "name": "귀리우유", "base_unit": "ml"}],
                   "items": [{"source_text": "맛있는우유 1L 12개입 29,000원",
                              "raw_item_name": "맛있는우유", "supplier_name": "A",
                              "quantity_per_unit": 1, "quantity_unit": "L", "units_per_pack": 12,
                              "order_unit": "box", "price": 29000, "price_basis": "per_pack",
                              "vat_status": "included"}]}
        with patch("app.tools.quote.normalize.search", return_value={"hits": hits}):
            response = self.client.post("/tools/quote/normalize", json=payload)
        self.assertEqual(response.status_code, 200)
        return response.json()["items"][0]

    def test_single_rag_candidate_is_used(self):
        row = self._rag_normalize([{"item_id": "milk", "score": 0.76},
                                   {"item_id": "milk", "score": 0.7}])
        self.assertEqual(row["item_id"], "milk")
        self.assertEqual(row["normalized_quantity_per_pack"], 12000)
        self.assertTrue(row["comparable"])
        self.assertEqual([i["code"] for i in row["issues"]], ["ITEM_MATCHED_BY_RAG"])
        self.assertFalse(row["issues"][0]["blocks_comparison"])

    def test_several_rag_candidates_need_confirmation(self):
        row = self._rag_normalize([{"item_id": "milk", "score": 0.76},
                                   {"item_id": "oat", "score": 0.7}])
        self.assertIsNone(row["item_id"])
        self.assertEqual(row["candidate_item_ids"], ["milk", "oat"])
        self.assertFalse(row["comparable"])
        self.assertIn("ITEM_CONFIRMATION_REQUIRED", [i["code"] for i in row["issues"]])

    def test_gross_need_and_missing_takeaway(self):
        bean = {"item_id": "bean", "unit": "g", "amount_per_cup": 18}
        response = self.client.post("/tools/quote/requirements", json={
            "sales_plan": [{"menu_id": "am", "cups": 100}, {"menu_id": "latte", "cups": 50}],
            "recipes": {"am": [bean], "latte": [bean, {"item_id": "cup", "unit": "개",
                                                   "amount_per_cup": 1, "scope": "takeaway"}]},
        })
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data["items"][0]["gross_need"], 2700)
        self.assertEqual(data["status"], "needs_input")
        self.assertEqual(data["issues"][0]["code"], "MISSING_TAKEAWAY_CUPS")

    def test_search_without_evidence(self):
        with patch("app.rag.quote_search.retrieve", return_value=[]):
            response = self.client.post("/tools/quote/search", json={
                "store_id": "demo", "document_type": "assumption", "query": "근거 없는 질문",
            })
        self.assertEqual(response.json(), {"status": "no_evidence", "hits": []})

    def test_parse_keeps_minimum_order(self):
        raw = ('{"items": [], "sales": [], "delivery": [{"source_text": "최소 주문 76,000원", '
               '"supplier_name": "R1", "fee_amount": 2900, "free_shipping_minimum": 78800, '
               '"minimum_order_amount": 76000}]}')
        with patch("app.tools.quote.parse.claude_json", return_value=raw), \
                patch.dict("os.environ", {"ANTHROPIC_MODEL": "m", "ANTHROPIC_API_KEY": "k"}):
            response = self.client.post("/tools/quote/parse",
                                        json={"text": "배송비 2,900원 · 최소 주문 76,000원"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["delivery"][0]["minimum_order_amount"], 76000)

    def test_blank_parse_rejected(self):
        self.assertEqual(self.client.post("/tools/quote/parse", json={"text": "  "}).status_code, 400)

    def test_line_without_order_unit_is_one_unit(self):
        # 사장님 문자에 흔한 "원두 1kg 22,000원"(주문 단위·가격 기준 없음)은 1개 가격으로 보고 계산에 넣는다.
        # "1L 12개 31,000원"은 12개 묶음 가격. 박스인데 몇 개인지 없으면 지금처럼 막는다.
        payload = {"store_id": "demo", "dictionary_version": 1, "use_rag": False,
                   "dictionary": [{"item_id": "beans", "name": "원두", "base_unit": "g"},
                                  {"item_id": "milk", "name": "우유", "base_unit": "ml"}],
                   "items": [{"source_text": "원두 1kg 22,000원", "raw_item_name": "원두",
                              "supplier_name": "A", "specification_text": "1kg",
                              "quantity_per_unit": 1, "quantity_unit": "kg", "price": 22000},
                             {"source_text": "우유 1L 12개 31,000원", "raw_item_name": "우유",
                              "supplier_name": "A", "specification_text": "1L 12개",
                              "quantity_per_unit": 1, "quantity_unit": "L", "units_per_pack": 12,
                              "price": 31000, "price_basis": "per_pack"},
                             {"source_text": "우유 1L 한 박스 29,000원", "raw_item_name": "우유",
                              "supplier_name": "A", "quantity_per_unit": 1, "quantity_unit": "L",
                              "price": 29000}]}
        response = self.client.post("/tools/quote/normalize", json=payload)
        self.assertEqual(response.status_code, 200)
        beans, milk, boxed = response.json()["items"]
        self.assertTrue(beans["comparable"])
        self.assertEqual((beans["units_per_pack"], beans["order_unit"], beans["price_basis"]), (1, "개", "per_pack"))
        self.assertEqual((beans["normalized_quantity_per_pack"], beans["pack_price"]), (1000, 22000))
        self.assertIn({"code": "PACK_ASSUMED", "target_id": "quote-line-001", "field": "order_unit",
                       "blocks_comparison": False}, beans["issues"])
        self.assertTrue(milk["comparable"])
        self.assertEqual((milk["order_unit"], milk["normalized_quantity_per_pack"], milk["pack_price"]), ("묶음", 12000, 31000))
        self.assertFalse(boxed["comparable"])
        codes = [i["code"] for i in boxed["issues"]]
        self.assertIn("INVALID_OR_MISSING_PACK_COUNT", codes)
        self.assertNotIn("PACK_ASSUMED", codes)

    def test_pack_word_in_order_unit_or_whole_word_only(self):
        # 주문 단위 칸이 "박스"인데 몇 개인지 없으면 막는다. 상품명 속 "set"(Sunset)은 묶음이 아니라 1개로 본다.
        payload = {"store_id": "demo", "dictionary_version": 1, "use_rag": False,
                   "dictionary": [{"item_id": "beans", "name": "원두", "base_unit": "g"},
                                  {"item_id": "milk", "name": "우유", "base_unit": "ml"}],
                   "items": [{"source_text": "우유 1L 29,000원", "raw_item_name": "우유", "supplier_name": "A",
                              "quantity_per_unit": 1, "quantity_unit": "L", "order_unit": "박스", "price": 29000},
                             {"source_text": "Sunset 원두 1kg 22,000원", "raw_item_name": "원두",
                              "supplier_name": "A", "quantity_per_unit": 1, "quantity_unit": "kg", "price": 22000}]}
        boxed, sunset = self.client.post("/tools/quote/normalize", json=payload).json()["items"]
        self.assertFalse(boxed["comparable"])
        self.assertNotIn("PACK_ASSUMED", [i["code"] for i in boxed["issues"]])
        self.assertTrue(sunset["comparable"])
        self.assertEqual((sunset["units_per_pack"], sunset["order_unit"]), (1, "개"))

    def test_complete_line_is_not_marked_assumed(self):
        payload = {"store_id": "demo", "dictionary_version": 1, "use_rag": False,
                   "dictionary": [{"item_id": "beans", "name": "원두", "base_unit": "g"}],
                   "items": [{"source_text": "원두 1kg 1봉 23,000원", "raw_item_name": "원두",
                              "supplier_name": "A", "quantity_per_unit": 1, "quantity_unit": "kg",
                              "units_per_pack": 1, "order_unit": "봉", "price": 23000,
                              "price_basis": "per_pack", "vat_status": "included"}]}
        row = self.client.post("/tools/quote/normalize", json=payload).json()["items"][0]
        self.assertTrue(row["comparable"])
        self.assertEqual(row["issues"], [])


if __name__ == "__main__":
    unittest.main()
