export type Amount = number | string | null
export type Vat = 'INCLUDED' | 'EXCLUDED' | 'UNKNOWN'
export type Answer = { type: 'OPTION'; value: string } | { type: 'TEXT'; text: string }
export type Question = {
  question_id: string; state: string; message: string
  target_id: string; field: string; options?: { value: string; label: string }[]
}
export type Snapshot = {
  preparation_id: string; version: number; stage: string
  statuses: { quote_status: string; material_status: string; optimization_status: string }
  messages: { message_id: string; role: 'USER' | 'ASSISTANT'; text: string; question_id?: string }[]
  questions: Question[]
  sales_plan: { items: { menu_id: string; menu_name: string; recent_3_day_quantity: Amount;
    quantity: Amount; source: string }[] }
  material_requirements: { items: { ingredient_id: string; ingredient_name: string; unit: string;
    usage_per_serving: { menu_id: string | null; label: string; quantity: number; planned_servings: number }[];
    required_quantity: Amount; available_inventory_quantity: Amount; safety_stock_quantity: Amount }[] }
  quotes: { supplier_count: number; suppliers: { supplier_id: string; supplier_name: string;
    shipping_rules: { condition: string; threshold_amount: Amount; fee_amount: Amount }[] }[];
    items: { line_id: string; supplier_id: string; display_group?: string; item_name: string;
      ingredient_id: string | null; spec_text: string | null; price_per_pack: Amount; vat_status: Vat }[] }
  issues: { code: string; target_id: string; field: string; message: string }[]
}
