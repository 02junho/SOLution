import assert from 'node:assert/strict'
import test from 'node:test'
import { amount, compareItems, compareSentence, deliveriesOf, josa, violationLabels } from '../src/features/easy/purchaseCompare.ts'

// 12곳 견적 시연 결과(1안 113,280원)와 같은 모양의 작은 예
const needs = [
  { item_id: 'milk', buy_need: 10400, base_unit: 'ml' },
  { item_id: 'ice_cup', buy_need: 130, base_unit: 'ea' },
]
const baseline = [
  { item_id: 'milk', item_name: '우유', supplier_id: 'M1', supplier_name: '유제품 가', pack_size: 12000, pack_count: 1, line_krw: 21600 },
  { item_id: 'ice_cup', item_name: '아이스컵', supplier_id: 'P1', supplier_name: '포장재 가', pack_size: 1000, pack_count: 1, line_krw: 48900 },
]
const chosen = [
  { item_id: 'milk', item_name: '우유', supplier_id: 'G', supplier_name: '온라인 대형몰', pack_size: 12000, pack_count: 1, line_krw: 32890 },
  { item_id: 'ice_cup', item_name: '아이스컵', supplier_id: 'G', supplier_name: '온라인 대형몰', pack_size: 100, pack_count: 2, line_krw: 12200 },
]

test('품목별로 단가만 본 안과 추천안을 나란히 놓는다', () => {
  const rows = compareItems(baseline, chosen, needs)
  assert.equal(rows.length, 2)
  const [milk, cup] = rows
  assert.equal(milk.item, '우유')
  assert.equal(milk.baseline.krw, 21600)
  assert.equal(milk.chosen.krw, 32890)
  assert.match(milk.pricierNote, /온라인 대형몰/)
  assert.equal(milk.overbuy, false)
  assert.equal(cup.baseline.packs, '1,000개 1묶음')
  assert.equal(cup.chosen.packs, '100개 × 2')
  assert.equal(cup.overbuy, true)
  assert.equal(cup.pricierNote, null)
})

test('한 줄 결론과 못 지킨 조건을 사장님 말로 만든다', () => {
  const rows = compareItems(baseline, chosen, needs)
  const sentence = compareSentence(rows, 2)
  assert.match(sentence, /아이스컵을 큰 상자째/)
  assert.match(sentence, /우유는 조금 비싸게 사는 대신 거래처 조건을 지키고 배송을 2번으로/)
  assert.deepEqual(violationLabels(['delivery_count', 'minimum_order'], 4, 2), ['배송 4번(정한 건 2번까지)', '최소 주문 금액을 못 채워요'])
  assert.equal(deliveriesOf(baseline), 2)
})

test('양 표시', () => {
  assert.equal(amount(2500, 'g'), '2.5kg')
  assert.equal(amount(500, 'g'), '500g')
  assert.equal(amount(12000, 'ml'), '12L')
  assert.equal(amount(1000, 'ea'), '1,000개')
})

test('받침에 맞춰 조사를 붙인다', () => {
  assert.equal(josa('아이스컵', '을', '를'), '아이스컵을')
  assert.equal(josa('우유', '은', '는'), '우유는')
  assert.equal(josa('아이스컵·핫컵', '을', '를'), '아이스컵·핫컵을')
})
