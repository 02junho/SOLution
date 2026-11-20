import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  inventory, mergeBatches, quotesTable, recipes, sales, sampleQuotes, upsertBatch,
} from '../src/features/purchase-preparation/quoteTestData.ts'

const csv = (path) => {
  const [head, ...rows] = readFileSync(new URL(path, import.meta.url), 'utf8').trim().split('\n')
  const keys = head.split(',')
  return rows.map(r => Object.fromEntries(r.split(',').map((v, i) => [keys[i], v])))
}
const suppliers = csv('../../data/demo/expanded/suppliers.csv')
const quotes = csv('../../data/demo/expanded/quotes.csv')
const won = (n) => Number(n).toLocaleString('ko-KR') + '원'

test('견적 화면 샘플의 총필요량·재고는 거래처 12곳 시연(1005)과 같다', () => {
  const need = {}
  for (const plan of sales.sales_plan) {
    for (const line of recipes.recipes[plan.menu_id]) {
      need[line.item_id] = (need[line.item_id] ?? 0) + plan.cups * line.amount_per_cup
    }
  }
  assert.deepEqual(need, {beans: 2700, ice_cup: 130, lid: 150, hot_cup: 20, milk: 10400})
  assert.deepEqual(Object.fromEntries(Object.entries(inventory.inventory).map(([k, v]) => [k, [v.usable_inventory, v.safety_stock]])),
    {beans: [1000, 500], milk: [2000, 2000], ice_cup: [50, 50], hot_cup: [30, 30], lid: [100, 50]})
})

test('샘플 견적 문자 12개는 data/demo/expanded의 거래처·가격·배송 조건을 그대로 담는다', () => {
  assert.deepEqual(sampleQuotes.map(q => q.supplier_name), suppliers.map(s => s.supplier_name))
  for (const s of suppliers) {
    const text = sampleQuotes.find(q => q.supplier_name === s.supplier_name).text
    for (const q of quotes.filter(q => q.supplier_id === s.supplier_id)) {
      assert.ok(text.includes(won(q.pack_price_krw)), `${s.supplier_name} ${q.item_id} ${q.pack_price_krw}`)
    }
    assert.ok(text.includes(Number(s.delivery_fee_krw) === 0 ? '배송비 무료' : `배송비 ${won(s.delivery_fee_krw)}`), s.supplier_name)
    if (s.free_delivery_min_krw) assert.ok(text.includes(`${won(s.free_delivery_min_krw)} 이상 무료배송`), s.supplier_name)
    assert.ok(text.includes(Number(s.minimum_order_krw) ? `최소 주문 금액 ${won(s.minimum_order_krw)}` : '최소 주문 금액 없음'), s.supplier_name)
    // 부가세 표기가 없는 견적은 부가세 확인이 필요한 예시로 남긴다.
    const vatUnknown = quotes.some(q => q.supplier_id === s.supplier_id && !q.vat_included)
    assert.equal(text.includes('부가세 포함'), !vatUnknown, s.supplier_name)
  }
})

const batch = (id, supplier, extra = {}) => ({
  quote_batch_id: id, confirmations: {}, sales_candidates: [],
  delivery: [{supplier_name: supplier, fee_amount: 3000, free_shipping_minimum: null, minimum_order_amount: 0, ...extra}],
  normalization: {items: [{line_id: 'quote-line-001', item_id: 'beans', raw_item_name: '원두', supplier_name: supplier,
    specification_text: null, normalized_quantity_per_pack: 1000, normalized_unit: 'g', pack_price: 19000,
    vat_status: 'included', issues: [{code: 'VAT_UNKNOWN', target_id: 'quote-line-001'}]}]},
})

test('거래처마다 따로 분석한 견적 묶음을 표 하나로 합치고 줄 번호가 겹치지 않게 한다', () => {
  assert.equal(mergeBatches([]), null)
  const one = mergeBatches([batch('b1', 'A')])
  assert.equal(one.normalization.items[0].line_id, 'quote-line-001')

  let list = upsertBatch([], batch('b1', 'A'))
  list = upsertBatch(list, batch('b2', 'B', {minimum_order_amount: 76000}))
  list = upsertBatch(list, {...batch('b1', 'A'), confirmations: {A: true}})
  assert.deepEqual(list.map(b => b.quote_batch_id), ['b1', 'b2'])

  const merged = mergeBatches(list)
  assert.deepEqual(merged.normalization.items.map(r => r.line_id), ['1-quote-line-001', '2-quote-line-001'])
  assert.equal(merged.normalization.items[1].issues[0].target_id, '2-quote-line-001')
  assert.deepEqual(merged.confirmations, {A: true})

  const table = quotesTable(merged)
  assert.equal(table.supplier_count, 2)
  assert.deepEqual(table.suppliers[1].shipping_rules.find(r => r.condition === 'MIN_ORDER'),
    {condition: 'MIN_ORDER', threshold_amount: 76000, fee_amount: null})
})
