import type { Amount } from './purchasePreparation'

export type Item = {item_id: string; name: string; base_unit: string; aliases?: string[]}
export type Dictionary = {version: number; items: Item[]}
export type Sales = {
  start_date: string; end_date: string
  recent_actuals: {menu_id: string; cups: number; start_date: string; end_date: string}[]
  sales_plan: {menu_id: string; cups: number; takeaway_cups?: number}[]
}
export type Issue = {code: string; target_id?: string; field?: string; menu_id?: string; item_id?: string}
export type ManualQuote = {items: {
  supplier_name: string; raw_item_name: string; quantity_per_unit: number; quantity_unit: string
  units_per_pack: number; order_unit: string; price: number; price_basis: string; vat_status: string
}[]}
export type Batch = {
  quote_batch_id: string
  normalization: {items: {
    line_id: string; item_id: string | null; raw_item_name: string; supplier_name: string | null
    specification_text: string | null; normalized_quantity_per_pack: Amount; normalized_unit: string | null
    pack_price: Amount; vat_status: string; issues: Issue[]
  }[]}
  confirmations: Record<string, boolean>
  delivery: {supplier_name: string | null; fee_amount: Amount; free_shipping_minimum: Amount}[]
  sales_candidates: unknown[]
}
export type Preview = {
  status: string
  items: {
    item_id: string; unit: string; gross_need: Amount; usable_inventory: Amount; safety_stock: Amount
    usage: {menu_id: string; cups: number; amount_per_cup: number | string}[]
  }[]
  issues: Issue[]
}
