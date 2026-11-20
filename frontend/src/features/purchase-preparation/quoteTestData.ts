import type {Batch, Dictionary, Issue, ManualQuote, Preview, Sales} from '../../types/quoteIntegration'
import type {Snapshot, Vat} from '../../types/purchasePreparation'

export const dictionary: Dictionary = {version: 1, items: [
  {item_id: 'milk', name: '우유', base_unit: 'ml', aliases: ['흰우유']},
  {item_id: 'bean', name: '원두', base_unit: 'g'},
]}
const bean = {item_id: 'bean', unit: 'g', amount_per_cup: 18, scope: 'all'}
export const recipes = {recipes: {americano: [bean], latte: [bean, {item_id: 'milk', unit: 'ml', amount_per_cup: 200, scope: 'all'}]}}
export const inventory = {inventory: {
  bean: {unit: 'g', usable_inventory: 1000, safety_stock: 500},
  milk: {unit: 'ml', usable_inventory: 2000, safety_stock: 1000},
}}
export const sales: Sales = {
  start_date: '2026-11-16', end_date: '2026-11-22',
  recent_actuals: [{menu_id: 'americano', cups: 90, start_date: '2026-11-13', end_date: '2026-11-15'}],
  sales_plan: [{menu_id: 'americano', cups: 100}, {menu_id: 'latte', cups: 50}],
}
export const manualQuote: ManualQuote = {items: [{
  supplier_name: 'A식자재', raw_item_name: '흰우유', quantity_per_unit: 1, quantity_unit: 'L',
  units_per_pack: 12, order_unit: 'box', price: 29000, price_basis: 'per_pack', vat_status: 'unknown',
}]}
export const sampleText = '흰우유 1L 12개입 한 박스 29,000원'
const menuName = (id: string) => ({americano: '아메리카노', latte: '카페라떼'})[id] ?? id
export function salesTable(value: Sales | null): Snapshot['sales_plan'] {
  return {items: (value?.sales_plan ?? []).map(p => ({
    menu_id: p.menu_id, menu_name: menuName(p.menu_id), quantity: p.cups, source: 'OWNER_INPUT',
    recent_3_day_quantity: null, // Spring 제공 실적의 기간은 아래 별도 표시에서 검증한다.
  }))}
}
// 현재 API는 실적을 일자별로 제공하지 않는다. 기준일 직전 3일이 정확히 일치하는 레코드만 열에 표시한다.
export function tableWithActuals(value: Sales | null): Snapshot['sales_plan'] {
  const result = salesTable(value)
  if (!value) return result
  const start = new Date(value.start_date + 'T00:00:00Z')
  if (Number.isNaN(start.getTime())) return result
  const prior = (days: number) => new Date(start.getTime() - days * 86400000).toISOString().slice(0,10)
  for (const row of result.items) {
    const matches = value.recent_actuals.filter(a => a.menu_id === row.menu_id && a.start_date === prior(3) && a.end_date === prior(1))
    if (matches.length === 1) row.recent_3_day_quantity = matches[0].cups
  }
  return result
}
export function materialsTable(value: Preview | null, dict: Dictionary | null): Snapshot['material_requirements'] {
  return {items: (value?.items ?? []).map(r => ({
    ingredient_id: r.item_id, ingredient_name: dict?.items.find(i => i.item_id === r.item_id)?.name ?? r.item_id, unit: r.unit,
    required_quantity: r.gross_need, available_inventory_quantity: r.usable_inventory, safety_stock_quantity: r.safety_stock,
    usage_per_serving: r.usage.map(u => ({menu_id: u.menu_id, label: menuName(u.menu_id), quantity: Number(u.amount_per_cup), planned_servings: u.cups})),
  }))}
}
export function quotesTable(value: Batch | null): Snapshot['quotes'] {
  const rows = value?.normalization.items ?? []
  const names = [...new Set(rows.map(r => r.supplier_name).filter((n): n is string => !!n))]
  return {
    supplier_count: names.length,
    suppliers: names.map(name => ({supplier_id: name, supplier_name: name, shipping_rules:
      (value?.delivery ?? []).filter(d => d.supplier_name === name).flatMap(d => [
        ...(d.free_shipping_minimum != null ? [{condition: 'AT_LEAST', threshold_amount: d.free_shipping_minimum, fee_amount: 0}] : []),
        ...(d.fee_amount != null ? [{condition: d.free_shipping_minimum == null ? 'ALWAYS' : 'BELOW', threshold_amount: d.free_shipping_minimum, fee_amount: d.fee_amount}] : []),
      ])})),
    items: rows.map(r => ({line_id: r.line_id, supplier_id: r.supplier_name ?? '', item_name: r.raw_item_name,
      ingredient_id: r.item_id, spec_text: r.specification_text ?? (r.normalized_quantity_per_pack == null ? null :
        Number(r.normalized_quantity_per_pack).toLocaleString('ko-KR') + (r.normalized_unit ?? '') + '/묶음'),
      price_per_pack: r.pack_price, vat_status: (['included','excluded'].includes(r.vat_status) ? r.vat_status.toUpperCase() : 'UNKNOWN') as Vat})),
  }
}
export function presentIssues(entries: Issue[]): Snapshot['issues'] {
  const labels: Record<string, string> = {
    VAT_UNKNOWN: '부가세 여부를 확인해야 합니다.',
    ITEM_CONFIRMATION_REQUIRED: '품목을 확인해야 합니다.',
    INVALID_OR_MISSING_PACK_COUNT: '묶음 수량을 확인해야 합니다.',
    INVENTORY_MISSING_OR_UNIT_MISMATCH: '재고 수량 또는 단위를 확인해야 합니다.',
    MISSING_RECIPE: '메뉴의 재료표를 등록해야 합니다.',
    MISSING_TAKEAWAY_CUPS: '포장 판매 잔수를 입력해야 합니다.',
  }
  return entries.map(x => ({code: x.code, target_id: x.target_id ?? x.item_id ?? x.menu_id ?? '',
    field: x.field ?? '', message: labels[x.code] ?? x.code}))
}
