-- 시연용 기본 데이터. DEMO_SEED=true일 때만 서버가 뜰 때 넣는다 (DemoSeedRunner).
-- 이미 있으면 건너뛴다(ON CONFLICT DO NOTHING). 서버가 만드는 PK(IdGenerator)는 매우 큰 수라 아래 작은 번호와 겹치지 않는다.
-- 시연 사용자는 application.yml의 demo.owner-key(기본 demo-owner)와 같아야 한다.

-- 매장 1곳: 을지로입구 개인 카페 (11.13 결정)
INSERT INTO store (store_id, owner_key, store_name, open_time, close_time)
VALUES (1, 'demo-owner', '을지로입구 데모 카페', '07:00:00', '19:00:00')
ON CONFLICT (store_id) DO NOTHING;

-- 구매 업무 3건. 모두 입력 확인을 마친 상태라 바로 구매안 계산 실행을 부를 수 있다.
-- 1001 정상: API 명세 예시 그대로 → 안 1 120,400원 · 안 2 138,000원 · 기준선 135,800원
-- 1002 실패: 같은 입력에 예산만 100,000원 → infeasible (최소 120,400원 필요)
-- 1003 질문: 우유 재고가 빈칸 → needs_input ("우유 재고가 지금 얼마나 있나요?")
INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version, step)
VALUES (1001, 1, 'purchase', 'form', '[시연] 이번 주 매입 (정상)', 1, 'review'),
       (1002, 1, 'purchase', 'form', '[시연] 이번 주 매입 (예산 부족)', 1, 'review'),
       (1003, 1, 'purchase', 'form', '[시연] 이번 주 매입 (재고 빈칸)', 1, 'review')
ON CONFLICT (session_id) DO NOTHING;

INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json,
                          input_confirmed_by, input_confirmed_at)
VALUES
(100101, 1001, 1, 'purchase-v1', '{
  "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
  "items": [
    {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
    {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 21000, "usable_inventory": 8000, "safety_stock": 2000, "storage_capacity": 40000}
  ],
  "suppliers": [
    {"supplier_id": "A", "supplier_name": "거래처 A", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null},
    {"supplier_id": "B", "supplier_name": "거래처 B", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null}
  ],
  "quotes": [
    {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "vat_included": true},
    {"supplier_id": "A", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34500, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 31900, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "vat_included": null}
  ]
}'::jsonb, 'demo-owner', now()),
(100201, 1002, 1, 'purchase-v1', '{
  "planning_days": 7, "budget_krw": 100000, "max_delivery_count": 2,
  "items": [
    {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
    {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 21000, "usable_inventory": 8000, "safety_stock": 2000, "storage_capacity": 40000}
  ],
  "suppliers": [
    {"supplier_id": "A", "supplier_name": "거래처 A", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null},
    {"supplier_id": "B", "supplier_name": "거래처 B", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null}
  ],
  "quotes": [
    {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "vat_included": true},
    {"supplier_id": "A", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34500, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 31900, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "vat_included": null}
  ]
}'::jsonb, 'demo-owner', now()),
(100301, 1003, 1, 'purchase-v1', '{
  "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
  "items": [
    {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
    {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 21000, "usable_inventory": null, "safety_stock": 2000, "storage_capacity": 40000}
  ],
  "suppliers": [
    {"supplier_id": "A", "supplier_name": "거래처 A", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null},
    {"supplier_id": "B", "supplier_name": "거래처 B", "minimum_order_krw": 30000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null}
  ],
  "quotes": [
    {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22000, "vat_included": true},
    {"supplier_id": "A", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34500, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 31900, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "vat_included": null}
  ]
}'::jsonb, 'demo-owner', now())
ON CONFLICT (input_version_id) DO NOTHING;
