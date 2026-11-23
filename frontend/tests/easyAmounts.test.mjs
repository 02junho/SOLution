import assert from 'node:assert/strict'
import test from 'node:test'
import { amountText, itemFacts, needLine } from '../src/features/easy/amounts.ts'
import { PURCHASE_INPUT } from '../src/features/easy/practiceStore.ts'

test('양은 kg·L·개로 읽기 쉽게', () => {
  assert.equal(amountText(2700, 'g'), '2.7kg')
  assert.equal(amountText(500, 'g'), '500g')
  assert.equal(amountText(10400, 'ml'), '10.4L')
  assert.equal(amountText(130, 'ea'), '130개')
})

test('연습 가게(업무 1005) 이번 주 쓸 양 한 줄', () => {
  assert.equal(needLine(PURCHASE_INPUT.items), '원두 2.7kg · 우유 10.4L · 아이스컵 130개 · 핫컵 20개 · 컵 뚜껑 150개')
})

test('양을 모르면 0이 아니라 확인 필요로', () => {
  assert.equal(needLine([{ item_name: '원두', base_unit: 'g', gross_need: null }]), '원두 확인 필요')
  assert.deepEqual(itemFacts([{ item_name: '원두', base_unit: 'g', gross_need: 2700, usable_inventory: 1000 }]), { '원두 쓸 양': '2.7kg', '원두 재고': '1kg' })
})
