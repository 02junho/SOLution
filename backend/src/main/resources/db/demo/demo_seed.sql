-- 시연용 기본 데이터. DEMO_SEED=true일 때만 서버가 뜰 때 넣는다 (DemoSeedRunner).
-- 이미 있으면 건너뛴다(ON CONFLICT DO NOTHING). 서버가 만드는 PK(IdGenerator)는 매우 큰 수라 아래 작은 번호와 겹치지 않는다.
-- 시연 사용자는 application.yml의 demo.owner-key(기본 demo-owner)와 같아야 한다.

-- 매장 1곳: 을지로입구 개인 카페 (11.13 결정)
INSERT INTO store (store_id, owner_key, store_name, open_time, close_time)
VALUES (1, 'demo-owner', '을지로입구 데모 카페', '07:00:00', '19:00:00')
ON CONFLICT (store_id) DO NOTHING;

-- 구매 업무 5건. 모두 입력 확인을 마친 상태라 바로 구매안 계산 실행을 부를 수 있다.
-- 1001 정상: API 명세 예시 그대로 → 안 1 120,400원 · 안 2 138,000원 · 기준선 135,800원
-- 1002 실패: 같은 입력에 예산만 100,000원 → infeasible (최소 120,400원 필요)
-- 1003 질문: 우유 재고가 빈칸 → needs_input ("우유 재고가 지금 얼마나 있나요?")
-- 1004 시연 본편: data/demo 자료 (품목 5 · 거래처 4, 최정경 확인 11.17)
--      → 안 1 125,500원 (B 우유 + C 나머지) · 안 2 127,500원 (C 한 곳) · 기준선 119,500원 (배송 3회 · 최소 주문 미달로 주문 불가)
--      총필요량은 판매 계획(아이스 아메리카노 100 · 아이스 라떼 30 · 핫 라떼 20잔) × 재료표. 우유는 핫 라떼 220ml 기준 10,400ml.
-- 1005 거래처 12곳: data/demo/expanded 자료 (원두·우유·포장재 전문점 3곳씩 + 종합 3곳, 최정경 확인 11.18). 품목·재고는 1004와 같다
--      → 안 1 113,280원 (원두 소분 + 온라인 대형몰) · 안 2 127,500원 (카페 도매몰 한 곳) · 기준선 166,090원 (배송 4회 · 최소 주문 미달 · 보관 한도 초과로 주문 불가)
--      배송 한도를 3회로 바꾸면 안 1이 101,090원 (원두 소분 + 우유 직배송 + 컵 낱줄)으로 바뀐다. 값마다 근거는 드라이브 「시연 자료 확인 요청 2」
INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version, step)
VALUES (1001, 1, 'purchase', 'form', '[시연] 이번 주 매입 (정상)', 1, 'review'),
       (1002, 1, 'purchase', 'form', '[시연] 이번 주 매입 (예산 부족)', 1, 'review'),
       (1003, 1, 'purchase', 'form', '[시연] 이번 주 매입 (재고 빈칸)', 1, 'review'),
       (1004, 1, 'purchase', 'form', '[시연] 이번 주 매입 (거래처 4곳)', 1, 'review'),
       (1005, 1, 'purchase', 'form', '[시연] 이번 주 매입 (거래처 12곳)', 1, 'review')
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
}'::jsonb, 'demo-owner', now()),
(100401, 1004, 1, 'purchase-v1', '{
  "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
  "items": [
    {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
    {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 10400, "usable_inventory": 2000, "safety_stock": 2000, "storage_capacity": 24000},
    {"item_id": "ice_cup", "item_name": "아이스컵", "base_unit": "ea", "gross_need": 130, "usable_inventory": 50, "safety_stock": 50, "storage_capacity": 1000},
    {"item_id": "hot_cup", "item_name": "핫컵", "base_unit": "ea", "gross_need": 20, "usable_inventory": 30, "safety_stock": 30, "storage_capacity": 500},
    {"item_id": "lid", "item_name": "컵 뚜껑", "base_unit": "ea", "gross_need": 150, "usable_inventory": 100, "safety_stock": 50, "storage_capacity": 1000}
  ],
  "suppliers": [
    {"supplier_id": "A", "supplier_name": "거래처 A (원두 로스터리)", "minimum_order_krw": 70000, "delivery_fee_krw": 3000, "free_delivery_min_krw": null},
    {"supplier_id": "B", "supplier_name": "거래처 B (유제품 대리점)", "minimum_order_krw": 20000, "delivery_fee_krw": 4000, "free_delivery_min_krw": 50000},
    {"supplier_id": "C", "supplier_name": "거래처 C (카페 도매몰)", "minimum_order_krw": 0, "delivery_fee_krw": 5000, "free_delivery_min_krw": 150000},
    {"supplier_id": "D", "supplier_name": "거래처 D (동네 식자재마트)", "minimum_order_krw": 0, "delivery_fee_krw": 2000, "free_delivery_min_krw": null}
  ],
  "quotes": [
    {"supplier_id": "A", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 20000, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 28000, "vat_included": true},
    {"supplier_id": "B", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 16500, "vat_included": null},
    {"supplier_id": "C", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 23000, "vat_included": true},
    {"supplier_id": "C", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34000, "vat_included": true},
    {"supplier_id": "C", "item_id": "ice_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 4000, "vat_included": true},
    {"supplier_id": "C", "item_id": "hot_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 4500, "vat_included": true},
    {"supplier_id": "C", "item_id": "lid", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 3000, "vat_included": true},
    {"supplier_id": "D", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 26000, "vat_included": true},
    {"supplier_id": "D", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 19800, "vat_included": true},
    {"supplier_id": "D", "item_id": "ice_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 5000, "vat_included": true},
    {"supplier_id": "D", "item_id": "hot_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 5500, "vat_included": true},
    {"supplier_id": "D", "item_id": "lid", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 3500, "vat_included": true}
  ]
}'::jsonb, 'demo-owner', now()),
(100501, 1005, 1, 'purchase-v1', '{
  "planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2,
  "items": [
    {"item_id": "beans", "item_name": "원두", "base_unit": "g", "gross_need": 2700, "usable_inventory": 1000, "safety_stock": 500, "storage_capacity": 5000},
    {"item_id": "milk", "item_name": "우유", "base_unit": "ml", "gross_need": 10400, "usable_inventory": 2000, "safety_stock": 2000, "storage_capacity": 24000},
    {"item_id": "ice_cup", "item_name": "아이스컵", "base_unit": "ea", "gross_need": 130, "usable_inventory": 50, "safety_stock": 50, "storage_capacity": 1000},
    {"item_id": "hot_cup", "item_name": "핫컵", "base_unit": "ea", "gross_need": 20, "usable_inventory": 30, "safety_stock": 30, "storage_capacity": 500},
    {"item_id": "lid", "item_name": "컵 뚜껑", "base_unit": "ea", "gross_need": 150, "usable_inventory": 100, "safety_stock": 50, "storage_capacity": 1000}
  ],
  "suppliers": [
    {"supplier_id": "R1", "supplier_name": "원두 로스터리 가 (대량 납품)", "minimum_order_krw": 76000, "delivery_fee_krw": 2900, "free_delivery_min_krw": 78800},
    {"supplier_id": "R2", "supplier_name": "원두 로스터리 나 (일반 납품)", "minimum_order_krw": 0, "delivery_fee_krw": 3000, "free_delivery_min_krw": 50000},
    {"supplier_id": "R3", "supplier_name": "원두 로스터리 다 (소분 판매)", "minimum_order_krw": 0, "delivery_fee_krw": 3000, "free_delivery_min_krw": null},
    {"supplier_id": "M1", "supplier_name": "유제품 대리점 가 (지역 직배송)", "minimum_order_krw": 0, "delivery_fee_krw": 0, "free_delivery_min_krw": null},
    {"supplier_id": "M2", "supplier_name": "유제품 대리점 나 (낱개 판매)", "minimum_order_krw": 0, "delivery_fee_krw": 3000, "free_delivery_min_krw": 30000},
    {"supplier_id": "M3", "supplier_name": "유제품 대리점 다 (6개 묶음)", "minimum_order_krw": 0, "delivery_fee_krw": 4000, "free_delivery_min_krw": 50000},
    {"supplier_id": "P1", "supplier_name": "포장재 도매 가 (박스 단위)", "minimum_order_krw": 0, "delivery_fee_krw": 0, "free_delivery_min_krw": null},
    {"supplier_id": "P2", "supplier_name": "포장재 도매 나 (100개 묶음)", "minimum_order_krw": 0, "delivery_fee_krw": 3000, "free_delivery_min_krw": 50000},
    {"supplier_id": "P3", "supplier_name": "포장재 소매 다 (50개 낱줄)", "minimum_order_krw": 0, "delivery_fee_krw": 3000, "free_delivery_min_krw": null},
    {"supplier_id": "C", "supplier_name": "카페 도매몰", "minimum_order_krw": 0, "delivery_fee_krw": 5000, "free_delivery_min_krw": 150000},
    {"supplier_id": "D", "supplier_name": "동네 식자재마트", "minimum_order_krw": 0, "delivery_fee_krw": 2000, "free_delivery_min_krw": null},
    {"supplier_id": "G", "supplier_name": "온라인 대형몰", "minimum_order_krw": 0, "delivery_fee_krw": 3000, "free_delivery_min_krw": 19800}
  ],
  "quotes": [
    {"supplier_id": "R1", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 19000, "vat_included": true},
    {"supplier_id": "R2", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 25000, "vat_included": true},
    {"supplier_id": "R3", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 22700, "vat_included": true},
    {"supplier_id": "R3", "item_id": "beans", "pack_size": 500, "pack_unit": "g", "pack_price_krw": 14800, "vat_included": true},
    {"supplier_id": "M1", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 21600, "vat_included": true},
    {"supplier_id": "M2", "item_id": "milk", "pack_size": 1000, "pack_unit": "ml", "pack_price_krw": 2050, "vat_included": true},
    {"supplier_id": "M3", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 11100, "vat_included": null},
    {"supplier_id": "P1", "item_id": "ice_cup", "pack_size": 1000, "pack_unit": "ea", "pack_price_krw": 48900, "vat_included": true},
    {"supplier_id": "P1", "item_id": "hot_cup", "pack_size": 1000, "pack_unit": "ea", "pack_price_krw": 30900, "vat_included": true},
    {"supplier_id": "P1", "item_id": "lid", "pack_size": 1000, "pack_unit": "ea", "pack_price_krw": 19620, "vat_included": true},
    {"supplier_id": "P2", "item_id": "ice_cup", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 5500, "vat_included": true},
    {"supplier_id": "P2", "item_id": "hot_cup", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 3200, "vat_included": true},
    {"supplier_id": "P2", "item_id": "lid", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 1790, "vat_included": true},
    {"supplier_id": "P3", "item_id": "ice_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 3100, "vat_included": true},
    {"supplier_id": "P3", "item_id": "hot_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 1650, "vat_included": true},
    {"supplier_id": "P3", "item_id": "lid", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 1170, "vat_included": true},
    {"supplier_id": "C", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 23000, "vat_included": true},
    {"supplier_id": "C", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 34000, "vat_included": true},
    {"supplier_id": "C", "item_id": "ice_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 4000, "vat_included": true},
    {"supplier_id": "C", "item_id": "hot_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 4500, "vat_included": true},
    {"supplier_id": "C", "item_id": "lid", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 3000, "vat_included": true},
    {"supplier_id": "D", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 26000, "vat_included": true},
    {"supplier_id": "D", "item_id": "milk", "pack_size": 6000, "pack_unit": "ml", "pack_price_krw": 19800, "vat_included": true},
    {"supplier_id": "D", "item_id": "ice_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 5000, "vat_included": true},
    {"supplier_id": "D", "item_id": "hot_cup", "pack_size": 50, "pack_unit": "ea", "pack_price_krw": 5500, "vat_included": true},
    {"supplier_id": "D", "item_id": "lid", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 3500, "vat_included": true},
    {"supplier_id": "G", "item_id": "beans", "pack_size": 1000, "pack_unit": "g", "pack_price_krw": 27000, "vat_included": true},
    {"supplier_id": "G", "item_id": "milk", "pack_size": 12000, "pack_unit": "ml", "pack_price_krw": 32890, "vat_included": true},
    {"supplier_id": "G", "item_id": "ice_cup", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 6100, "vat_included": true},
    {"supplier_id": "G", "item_id": "hot_cup", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 3200, "vat_included": true},
    {"supplier_id": "G", "item_id": "lid", "pack_size": 100, "pack_unit": "ea", "pack_price_krw": 1790, "vat_included": true}
  ]
}'::jsonb, 'demo-owner', now())
ON CONFLICT (input_version_id) DO NOTHING;

-- 운영 업무 3건. 입력 확인을 마친 상태라 바로 운영 계산 실행(POST /api/v1/operation/sessions/{id}/results)을 부를 수 있다.
-- 입력은 폼 값만 담는다({"operation_form": {...}}). 근무표 세 안은 계산할 때 OperationInputBuilder가 만든다.
-- 비워 둔 칸(라스트 오더 등)은 계산할 때 기본값을 쓴다. 바쁜 시간은 입력이 아니라 상권 데이터의 가장 바쁜 시간대(11~14시)다.
-- 2001 사장님 + 직원 1명 07~19시(한 명 추가 안은 바쁜 시간에 직원 1명 더), 하루 150건
-- 2002 같은 인원, 하루 276건(을지로입구 상권 평균)
-- 2003 직원 2명 07~19시, 하루 150건
-- 이 블록이 바뀌기 전(근무표까지 든 완성본)에 시연 데이터를 넣은 DB는 예전 모양이 남아 있어도 계산된다(빌더가 그대로 둠).
INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version, step)
VALUES (2001, 1, 'operation', 'form', '[시연] 운영 실험 (평일 150건)', 1, 'review'),
       (2002, 1, 'operation', 'form', '[시연] 운영 실험 (바쁜 날 276건)', 1, 'review'),
       (2003, 1, 'operation', 'form', '[시연] 운영 실험 (사장님 근무 안 함)', 1, 'review')
ON CONFLICT (session_id) DO NOTHING;

INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json,
                          input_confirmed_by, input_confirmed_at)
VALUES
(200101, 2001, 1, 'operation.v1', '{"operation_form": {
  "business_date": "2026-11-18", "daily_orders": 150, "is_owner_working": true, "hourly_wage_krw": 10320
}}'::jsonb, 'demo-owner', now()),
(200201, 2002, 1, 'operation.v1', '{"operation_form": {
  "business_date": "2026-11-18", "daily_orders": 276, "is_owner_working": true, "hourly_wage_krw": 10320
}}'::jsonb, 'demo-owner', now()),
(200301, 2003, 1, 'operation.v1', '{"operation_form": {
  "business_date": "2026-11-18", "daily_orders": 150, "is_owner_working": false, "hourly_wage_krw": 10320
}}'::jsonb, 'demo-owner', now())
ON CONFLICT (input_version_id) DO NOTHING;


-- 견적 기능 시연용 품목 사전
INSERT INTO quote_demo_resource (
    store_id,
    resource_key,
    version,
    payload
)
VALUES (
    'quote-test-e80ab4ba-4da',
    'items',
    2,
    '{
        "version": 2,
        "items": [
            {
                "item_id": "beans",
                "name": "원두",
                "base_unit": "g",
                "aliases": [
                    "커피콩",
                    "블렌드 원두",
                    "에스프레소 블렌드"
                ],
                "specifications": ["1kg"]
            },
            {
                "item_id": "milk",
                "name": "우유",
                "base_unit": "ml",
                "aliases": [
                    "흰우유",
                    "카페우유",
                    "멸균우유"
                ],
                "specifications": ["1L"]
            },
            {
                "item_id": "ice_cup",
                "name": "아이스컵",
                "base_unit": "개",
                "aliases": [
                    "PET컵",
                    "투명컵",
                    "16온스컵"
                ],
                "specifications": ["16oz"]
            },
            {
                "item_id": "hot_cup",
                "name": "핫컵",
                "base_unit": "개",
                "aliases": [
                    "종이컵",
                    "13온스컵"
                ],
                "specifications": ["13oz"]
            },
            {
                "item_id": "lid",
                "name": "컵 뚜껑",
                "base_unit": "개",
                "aliases": [
                    "뚜껑",
                    "리드",
                    "컵뚜껑"
                ],
                "specifications": []
            }
        ]
    }'::jsonb
)
ON CONFLICT (store_id, resource_key, version)
DO NOTHING;


-- 견적 기능 시연용 메뉴 재료표
INSERT INTO quote_demo_resource (
    store_id,
    resource_key,
    version,
    payload
)
VALUES (
    'quote-test-e80ab4ba-4da',
    'recipes',
    1,
    '{
        "recipes": {
            "iced_americano": [
                {
                    "item_id": "beans",
                    "unit": "g",
                    "amount_per_cup": 18,
                    "scope": "all"
                },
                {
                    "item_id": "ice_cup",
                    "unit": "개",
                    "amount_per_cup": 1,
                    "scope": "takeaway"
                },
                {
                    "item_id": "lid",
                    "unit": "개",
                    "amount_per_cup": 1,
                    "scope": "takeaway"
                }
            ],
            "iced_latte": [
                {
                    "item_id": "beans",
                    "unit": "g",
                    "amount_per_cup": 18,
                    "scope": "all"
                },
                {
                    "item_id": "milk",
                    "unit": "ml",
                    "amount_per_cup": 200,
                    "scope": "all"
                },
                {
                    "item_id": "ice_cup",
                    "unit": "개",
                    "amount_per_cup": 1,
                    "scope": "takeaway"
                },
                {
                    "item_id": "lid",
                    "unit": "개",
                    "amount_per_cup": 1,
                    "scope": "takeaway"
                }
            ],
            "hot_latte": [
                {
                    "item_id": "beans",
                    "unit": "g",
                    "amount_per_cup": 18,
                    "scope": "all"
                },
                {
                    "item_id": "milk",
                    "unit": "ml",
                    "amount_per_cup": 220,
                    "scope": "all"
                },
                {
                    "item_id": "hot_cup",
                    "unit": "개",
                    "amount_per_cup": 1,
                    "scope": "takeaway"
                },
                {
                    "item_id": "lid",
                    "unit": "개",
                    "amount_per_cup": 1,
                    "scope": "takeaway"
                }
            ]
        }
    }'::jsonb
)
ON CONFLICT (store_id, resource_key, version)
DO NOTHING;

-- 견적 기능 시연용 재고
INSERT INTO quote_demo_resource (
    store_id,
    resource_key,
    version,
    payload
)
VALUES (
    'quote-test-e80ab4ba-4da',
    'inventory',
    1,
    '{
        "inventory": {
            "beans": {
                "unit": "g",
                "usable_inventory": 1000,
                "safety_stock": 500
            },
            "milk": {
                "unit": "ml",
                "usable_inventory": 2000,
                "safety_stock": 2000
            },
            "ice_cup": {
                "unit": "개",
                "usable_inventory": 50,
                "safety_stock": 50
            },
            "hot_cup": {
                "unit": "개",
                "usable_inventory": 30,
                "safety_stock": 30
            },
            "lid": {
                "unit": "개",
                "usable_inventory": 100,
                "safety_stock": 50
            }
        }
    }'::jsonb
)
ON CONFLICT (store_id, resource_key, version)
DO NOTHING;
-- 견적 기능 시연용 판매 계획 및 최근 판매 실적
INSERT INTO quote_demo_resource (
    store_id,
    resource_key,
    version,
    payload
)
VALUES (
    'quote-test-e80ab4ba-4da',
    'sales:87b31b51-d0b7-4e54-8013-f5f54b599929',
    1,
    '{
        "start_date": "2026-11-23",
        "end_date": "2026-11-29",
        "recent_actuals": [
            {
                "menu_id": "iced_americano",
                "cups": 45,
                "start_date": "2026-11-20",
                "end_date": "2026-11-22"
            },
            {
                "menu_id": "iced_latte",
                "cups": 15,
                "start_date": "2026-11-20",
                "end_date": "2026-11-22"
            },
            {
                "menu_id": "hot_latte",
                "cups": 10,
                "start_date": "2026-11-20",
                "end_date": "2026-11-22"
            }
        ],
        "sales_plan": [
            {
                "menu_id": "iced_americano",
                "cups": 100,
                "takeaway_cups": 100
            },
            {
                "menu_id": "iced_latte",
                "cups": 30,
                "takeaway_cups": 30
            },
            {
                "menu_id": "hot_latte",
                "cups": 20,
                "takeaway_cups": 20
            }
        ]
    }'::jsonb
)
ON CONFLICT (store_id, resource_key, version)
DO UPDATE SET payload = jsonb_set(
    quote_demo_resource.payload,
    '{recent_actuals}',
    EXCLUDED.payload -> 'recent_actuals',
    true
);
