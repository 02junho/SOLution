// 쉬운 화면 테스트용 연습 가게 입력. 매입은 시연 업무 1005(거래처 12곳) 시드와 같고, 운영은 시연 업무 2001과 같다.
// 테스트할 때마다 새 업무를 만들어 이 값을 폼 입력으로 저장한다. 실제 가게 숫자가 아니다.
import type { JsonObject } from '../../types/workflow'

export const PURCHASE_INPUT: JsonObject = {
  "planning_days": 7,
  "budget_krw": 200000,
  "max_delivery_count": 2,
  "items": [
    {
      "item_id": "beans",
      "item_name": "원두",
      "base_unit": "g",
      "gross_need": 2700,
      "usable_inventory": 1000,
      "safety_stock": 500,
      "storage_capacity": 5000
    },
    {
      "item_id": "milk",
      "item_name": "우유",
      "base_unit": "ml",
      "gross_need": 10400,
      "usable_inventory": 2000,
      "safety_stock": 2000,
      "storage_capacity": 24000
    },
    {
      "item_id": "ice_cup",
      "item_name": "아이스컵",
      "base_unit": "ea",
      "gross_need": 130,
      "usable_inventory": 50,
      "safety_stock": 50,
      "storage_capacity": 1000
    },
    {
      "item_id": "hot_cup",
      "item_name": "핫컵",
      "base_unit": "ea",
      "gross_need": 20,
      "usable_inventory": 30,
      "safety_stock": 30,
      "storage_capacity": 500
    },
    {
      "item_id": "lid",
      "item_name": "컵 뚜껑",
      "base_unit": "ea",
      "gross_need": 150,
      "usable_inventory": 100,
      "safety_stock": 50,
      "storage_capacity": 1000
    }
  ],
  "suppliers": [
    {
      "supplier_id": "R1",
      "supplier_name": "원두 로스터리 가 (대량 납품)",
      "minimum_order_krw": 76000,
      "delivery_fee_krw": 2900,
      "free_delivery_min_krw": 78800
    },
    {
      "supplier_id": "R2",
      "supplier_name": "원두 로스터리 나 (일반 납품)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 3000,
      "free_delivery_min_krw": 50000
    },
    {
      "supplier_id": "R3",
      "supplier_name": "원두 로스터리 다 (소분 판매)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 3000,
      "free_delivery_min_krw": null
    },
    {
      "supplier_id": "M1",
      "supplier_name": "유제품 대리점 가 (지역 직배송)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 0,
      "free_delivery_min_krw": null
    },
    {
      "supplier_id": "M2",
      "supplier_name": "유제품 대리점 나 (낱개 판매)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 3000,
      "free_delivery_min_krw": 30000
    },
    {
      "supplier_id": "M3",
      "supplier_name": "유제품 대리점 다 (6개 묶음)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 4000,
      "free_delivery_min_krw": 50000
    },
    {
      "supplier_id": "P1",
      "supplier_name": "포장재 도매 가 (박스 단위)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 0,
      "free_delivery_min_krw": null
    },
    {
      "supplier_id": "P2",
      "supplier_name": "포장재 도매 나 (100개 묶음)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 3000,
      "free_delivery_min_krw": 50000
    },
    {
      "supplier_id": "P3",
      "supplier_name": "포장재 소매 다 (50개 낱줄)",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 3000,
      "free_delivery_min_krw": null
    },
    {
      "supplier_id": "C",
      "supplier_name": "카페 도매몰",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 5000,
      "free_delivery_min_krw": 150000
    },
    {
      "supplier_id": "D",
      "supplier_name": "동네 식자재마트",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 2000,
      "free_delivery_min_krw": null
    },
    {
      "supplier_id": "G",
      "supplier_name": "온라인 대형몰",
      "minimum_order_krw": 0,
      "delivery_fee_krw": 3000,
      "free_delivery_min_krw": 19800
    }
  ],
  "quotes": [
    {
      "supplier_id": "R1",
      "item_id": "beans",
      "pack_size": 1000,
      "pack_unit": "g",
      "pack_price_krw": 19000,
      "vat_included": true
    },
    {
      "supplier_id": "R2",
      "item_id": "beans",
      "pack_size": 1000,
      "pack_unit": "g",
      "pack_price_krw": 25000,
      "vat_included": true
    },
    {
      "supplier_id": "R3",
      "item_id": "beans",
      "pack_size": 1000,
      "pack_unit": "g",
      "pack_price_krw": 22700,
      "vat_included": true
    },
    {
      "supplier_id": "R3",
      "item_id": "beans",
      "pack_size": 500,
      "pack_unit": "g",
      "pack_price_krw": 14800,
      "vat_included": true
    },
    {
      "supplier_id": "M1",
      "item_id": "milk",
      "pack_size": 12000,
      "pack_unit": "ml",
      "pack_price_krw": 21600,
      "vat_included": true
    },
    {
      "supplier_id": "M2",
      "item_id": "milk",
      "pack_size": 1000,
      "pack_unit": "ml",
      "pack_price_krw": 2050,
      "vat_included": true
    },
    {
      "supplier_id": "M3",
      "item_id": "milk",
      "pack_size": 6000,
      "pack_unit": "ml",
      "pack_price_krw": 11100,
      "vat_included": null
    },
    {
      "supplier_id": "P1",
      "item_id": "ice_cup",
      "pack_size": 1000,
      "pack_unit": "ea",
      "pack_price_krw": 48900,
      "vat_included": true
    },
    {
      "supplier_id": "P1",
      "item_id": "hot_cup",
      "pack_size": 1000,
      "pack_unit": "ea",
      "pack_price_krw": 30900,
      "vat_included": true
    },
    {
      "supplier_id": "P1",
      "item_id": "lid",
      "pack_size": 1000,
      "pack_unit": "ea",
      "pack_price_krw": 19620,
      "vat_included": true
    },
    {
      "supplier_id": "P2",
      "item_id": "ice_cup",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 5500,
      "vat_included": true
    },
    {
      "supplier_id": "P2",
      "item_id": "hot_cup",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 3200,
      "vat_included": true
    },
    {
      "supplier_id": "P2",
      "item_id": "lid",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 1790,
      "vat_included": true
    },
    {
      "supplier_id": "P3",
      "item_id": "ice_cup",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 3100,
      "vat_included": true
    },
    {
      "supplier_id": "P3",
      "item_id": "hot_cup",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 1650,
      "vat_included": true
    },
    {
      "supplier_id": "P3",
      "item_id": "lid",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 1170,
      "vat_included": true
    },
    {
      "supplier_id": "C",
      "item_id": "beans",
      "pack_size": 1000,
      "pack_unit": "g",
      "pack_price_krw": 23000,
      "vat_included": true
    },
    {
      "supplier_id": "C",
      "item_id": "milk",
      "pack_size": 12000,
      "pack_unit": "ml",
      "pack_price_krw": 34000,
      "vat_included": true
    },
    {
      "supplier_id": "C",
      "item_id": "ice_cup",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 4000,
      "vat_included": true
    },
    {
      "supplier_id": "C",
      "item_id": "hot_cup",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 4500,
      "vat_included": true
    },
    {
      "supplier_id": "C",
      "item_id": "lid",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 3000,
      "vat_included": true
    },
    {
      "supplier_id": "D",
      "item_id": "beans",
      "pack_size": 1000,
      "pack_unit": "g",
      "pack_price_krw": 26000,
      "vat_included": true
    },
    {
      "supplier_id": "D",
      "item_id": "milk",
      "pack_size": 6000,
      "pack_unit": "ml",
      "pack_price_krw": 19800,
      "vat_included": true
    },
    {
      "supplier_id": "D",
      "item_id": "ice_cup",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 5000,
      "vat_included": true
    },
    {
      "supplier_id": "D",
      "item_id": "hot_cup",
      "pack_size": 50,
      "pack_unit": "ea",
      "pack_price_krw": 5500,
      "vat_included": true
    },
    {
      "supplier_id": "D",
      "item_id": "lid",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 3500,
      "vat_included": true
    },
    {
      "supplier_id": "G",
      "item_id": "beans",
      "pack_size": 1000,
      "pack_unit": "g",
      "pack_price_krw": 27000,
      "vat_included": true
    },
    {
      "supplier_id": "G",
      "item_id": "milk",
      "pack_size": 12000,
      "pack_unit": "ml",
      "pack_price_krw": 32890,
      "vat_included": true
    },
    {
      "supplier_id": "G",
      "item_id": "ice_cup",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 6100,
      "vat_included": true
    },
    {
      "supplier_id": "G",
      "item_id": "hot_cup",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 3200,
      "vat_included": true
    },
    {
      "supplier_id": "G",
      "item_id": "lid",
      "pack_size": 100,
      "pack_unit": "ea",
      "pack_price_krw": 1790,
      "vat_included": true
    }
  ]
}

export const OPERATION_FORM = {
  daily_orders: 150,
  business_date: '2026-11-18',
  hourly_wage_krw: 10320,
  is_owner_working: true,
}
