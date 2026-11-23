import type {Batch, Dictionary, Issue, ManualQuote, Preview, Sales} from '../../types/quoteIntegration'
import type {Snapshot, Vat} from '../../types/purchasePreparation'

// 견적 화면 샘플: 거래처 12곳 시연(업무 1005, data/demo/expanded)과 같은 숫자다.
// 재료표 × 판매 계획 = 1005의 총필요량(원두 2,700g · 우유 10,400ml · 아이스컵 130 · 핫컵 20 · 뚜껑 150),
// 재고·안전재고도 1005와 같다. 견적 원문 12개를 분석하면 구매안이 1005와 같은 값으로 나온다.
// 버전은 AI 서버가 미리 넣어 둔 품목 검색(RAG) 자료(ai-server/app/scripts/quote-aliases-v2.jsonl)와 같아야 검색이 된다.
export const dictionary: Dictionary = {version: 2, items: [
  {item_id: 'beans', name: '원두', base_unit: 'g', aliases: ['원두 블렌드', '블렌드 원두', '커피 원두']},
  {item_id: 'milk', name: '우유', base_unit: 'ml', aliases: ['흰우유', '멸균우유']},
  {item_id: 'ice_cup', name: '아이스컵', base_unit: '개', aliases: ['아이스 컵', 'PET 아이스컵', '플라스틱컵']},
  {item_id: 'hot_cup', name: '핫컵', base_unit: '개', aliases: ['핫 컵', '종이컵']},
  {item_id: 'lid', name: '컵 뚜껑', base_unit: '개', aliases: ['컵뚜껑', '뚜껑', '리드']},
]}
const line = (item_id: string, unit: string, amount_per_cup: number) => ({item_id, unit, amount_per_cup, scope: 'all'})
export const recipes = {recipes: {
  iced_americano: [line('beans', 'g', 18), line('ice_cup', '개', 1), line('lid', '개', 1)],
  hot_americano: [line('beans', 'g', 18), line('hot_cup', '개', 1), line('lid', '개', 1)],
  iced_latte: [line('beans', 'g', 18), line('milk', 'ml', 200), line('ice_cup', '개', 1), line('lid', '개', 1)],
}}
export const inventory = {inventory: {
  beans: {unit: 'g', usable_inventory: 1000, safety_stock: 500},
  milk: {unit: 'ml', usable_inventory: 2000, safety_stock: 2000},
  ice_cup: {unit: '개', usable_inventory: 50, safety_stock: 50},
  hot_cup: {unit: '개', usable_inventory: 30, safety_stock: 30},
  lid: {unit: '개', usable_inventory: 100, safety_stock: 50},
}}
export const sales: Sales = {
  start_date: '2026-11-23', end_date: '2026-11-29',
  recent_actuals: [
    {menu_id: 'iced_americano', cups: 34, start_date: '2026-11-20', end_date: '2026-11-22'},
    {menu_id: 'hot_americano', cups: 8, start_date: '2026-11-20', end_date: '2026-11-22'},
    {menu_id: 'iced_latte', cups: 22, start_date: '2026-11-20', end_date: '2026-11-22'},
  ],
  sales_plan: [{menu_id: 'iced_americano', cups: 78}, {menu_id: 'hot_americano', cups: 20}, {menu_id: 'iced_latte', cups: 52}],
}
export const manualQuote: ManualQuote = {items: [{
  supplier_name: 'A식자재', raw_item_name: '흰우유', quantity_per_unit: 1, quantity_unit: 'L',
  units_per_pack: 12, order_unit: 'box', price: 29000, price_basis: 'per_pack', vat_status: 'unknown',
}]}
// 거래처 12곳의 견적 문자. 값은 data/demo/expanded(suppliers.csv · quotes.csv)와 같다.
// 유제품 대리점 다는 부가세 표기가 없어 "부가세 확인 필요"가 뜨는 예시다.
export const sampleQuotes: {supplier_name: string; text: string}[] = [
  {supplier_name: '원두 로스터리 가 (대량 납품)', text: '안녕하세요. 이번 주 납품 단가입니다.\n원두 1kg 1봉 19,000원\n부가세 포함 가격입니다.\n배송비 2,900원, 78,800원 이상 무료배송\n최소 주문 금액 76,000원'},
  {supplier_name: '원두 로스터리 나 (일반 납품)', text: '이번 주 단가 안내드려요.\n원두 1kg 1봉 25,000원\n부가세 포함\n배송비 3,000원, 50,000원 이상 무료배송\n최소 주문 금액 없음'},
  {supplier_name: '원두 로스터리 다 (소분 판매)', text: '원두 1kg 1봉 22,700원\n원두 500g 1봉 14,800원\n부가세 포함\n배송비 3,000원 (무료배송 없음)\n최소 주문 금액 없음'},
  {supplier_name: '유제품 대리점 가 (지역 직배송)', text: '우유 1L 12개 1박스 21,600원\n부가세 포함\n배송비 무료\n최소 주문 금액 없음'},
  {supplier_name: '유제품 대리점 나 (낱개 판매)', text: '우유 1L 1개 2,050원\n부가세 포함\n배송비 3,000원, 30,000원 이상 무료배송\n최소 주문 금액 없음'},
  {supplier_name: '유제품 대리점 다 (6개 묶음)', text: '우유 1L 6개 1묶음 11,100원\n배송비 4,000원, 50,000원 이상 무료배송\n최소 주문 금액 없음'},
  {supplier_name: '포장재 도매 가 (박스 단위)', text: '아이스컵 1,000개 1박스 48,900원\n핫컵 1,000개 1박스 30,900원\n컵 뚜껑 1,000개 1박스 19,620원\n부가세 포함\n배송비 무료\n최소 주문 금액 없음'},
  {supplier_name: '포장재 도매 나 (100개 묶음)', text: '아이스컵 100개 1줄 5,500원\n핫컵 100개 1줄 3,200원\n컵 뚜껑 100개 1줄 1,790원\n부가세 포함\n배송비 3,000원, 50,000원 이상 무료배송\n최소 주문 금액 없음'},
  {supplier_name: '포장재 소매 다 (50개 낱줄)', text: '아이스컵 50개 1줄 3,100원\n핫컵 50개 1줄 1,650원\n컵 뚜껑 50개 1줄 1,170원\n부가세 포함\n배송비 3,000원 (무료배송 없음)\n최소 주문 금액 없음'},
  {supplier_name: '카페 도매몰', text: '원두 1kg 1봉 23,000원\n우유 1L 12개 1박스 34,000원\n아이스컵 50개 1줄 4,000원\n핫컵 50개 1줄 4,500원\n컵 뚜껑 100개 1줄 3,000원\n부가세 포함\n배송비 5,000원, 150,000원 이상 무료배송\n최소 주문 금액 없음'},
  {supplier_name: '동네 식자재마트', text: '원두 1kg 1봉 26,000원\n우유 1L 6개 1묶음 19,800원\n아이스컵 50개 1줄 5,000원\n핫컵 50개 1줄 5,500원\n컵 뚜껑 100개 1줄 3,500원\n부가세 포함\n배송비 2,000원 (무료배송 없음)\n최소 주문 금액 없음'},
  {supplier_name: '온라인 대형몰', text: '원두 1kg 1봉 27,000원\n우유 1L 12개 1박스 32,890원\n아이스컵 100개 1줄 6,100원\n핫컵 100개 1줄 3,200원\n컵 뚜껑 100개 1줄 1,790원\n부가세 포함\n배송비 3,000원, 19,800원 이상 무료배송\n최소 주문 금액 없음'},
]
export const sampleText = sampleQuotes[0].text
const menuName = (id: string) => ({iced_americano: '아이스 아메리카노', hot_americano: '핫 아메리카노', iced_latte: '아이스 카페라떼'})[id] ?? id
// 거래처마다 따로 분석한 견적 묶음들을 표 하나로 합친다. 줄 번호는 묶음마다 1부터라 앞에 묶음 순서를 붙인다.
// 같은 거래처의 배송 조건이 여러 묶음에 있으면 구매 입력 연결(PurchaseInputBuilder)과 같이 뒤 묶음 것만 쓴다.
export function mergeBatches(list: Batch[]): Batch | null {
  if (!list.length) return null
  const prefix = (i: number, id: string) => list.length > 1 ? `${i + 1}-${id}` : id
  const lastDelivery = new Map<string, number>()
  list.forEach((b, i) => b.delivery.forEach(d => { if (d.supplier_name) lastDelivery.set(d.supplier_name, i) }))
  return {
    quote_batch_id: list[list.length - 1].quote_batch_id,
    normalization: {dictionary_version: 2, items: list.flatMap((b, i) => b.normalization.items.map(r => ({...r, line_id: prefix(i, r.line_id),
      issues: r.issues.map(x => ({...x, target_id: x.target_id ? prefix(i, x.target_id) : x.target_id}))})))},
    confirmations: Object.assign({}, ...list.map(b => b.confirmations)),
    delivery: list.flatMap((b, i) => b.delivery.filter(d => !d.supplier_name || lastDelivery.get(d.supplier_name) === i)),
    sales_candidates: list.flatMap(b => b.sales_candidates),
  }
}
// 같은 묶음을 다시 받으면 바꾸고, 새 묶음이면 뒤에 붙인다.
export function upsertBatch(list: Batch[], data: Batch): Batch[] {
  return list.some(b => b.quote_batch_id === data.quote_batch_id)
    ? list.map(b => b.quote_batch_id === data.quote_batch_id ? data : b) : [...list, data]
}
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
        ...(d.minimum_order_amount != null ? [{condition: 'MIN_ORDER', threshold_amount: d.minimum_order_amount, fee_amount: null}] : []),
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
    ITEM_MATCHED_BY_RAG: '이름이 비슷한 품목으로 AI가 맞췄습니다. 맞는지 확인해 주세요.',
    INVALID_OR_MISSING_PACK_COUNT: '묶음 수량을 확인해야 합니다.',
    INVENTORY_MISSING_OR_UNIT_MISMATCH: '재고 수량 또는 단위를 확인해야 합니다.',
    MISSING_RECIPE: '메뉴의 재료표를 등록해야 합니다.',
    MISSING_TAKEAWAY_CUPS: '포장 판매 잔수를 입력해야 합니다.',
  }
  return entries.map(x => ({code: x.code, target_id: x.target_id ?? x.item_id ?? x.menu_id ?? '',
    field: x.field ?? '', message: labels[x.code] ?? x.code}))
}
