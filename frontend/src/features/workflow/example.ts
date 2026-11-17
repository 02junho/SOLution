import type { JsonObject } from '../../types/workflow'

export function purchaseExample(): JsonObject {
  return {
    planning_days: 7,
    budget_krw: 150000,
    max_delivery_count: 2,
    items: [
      {
        item_id: 'coffee',
        item_name: '원두',
        base_unit: 'g',
        gross_need: 2700,
        usable_inventory: 1000,
        safety_stock: 500,
        storage_capacity: null,
        max_end_inventory: null,
      },
      {
        item_id: 'milk',
        item_name: '우유',
        base_unit: 'ml',
        gross_need: 12000,
        usable_inventory: 2000,
        safety_stock: 1000,
        storage_capacity: null,
        max_end_inventory: null,
      },
    ],
    suppliers: [
      {
        supplier_id: 'supplier-a',
        supplier_name: '모닝 식자재',
        minimum_order_krw: 0,
        delivery_fee_krw: 3000,
        free_delivery_min_krw: 50000,
      },
    ],
    quotes: [
      {
        supplier_id: 'supplier-a',
        item_id: 'coffee',
        pack_size: 1000,
        pack_unit: 'g',
        pack_price_krw: 24000,
        vat_included: true,
      },
      {
        supplier_id: 'supplier-a',
        item_id: 'milk',
        pack_size: 1000,
        pack_unit: 'ml',
        pack_price_krw: 2100,
        vat_included: null,
      },
    ],
  }
}
