import assert from 'node:assert/strict'
import test from 'node:test'
import { applyChanges, changeText, usable } from '../src/features/easy/suggest.ts'

const input = { budget_krw: 100000, max_delivery_count: 1, items: [{ item_id: 'beans', storage_capacity: 3000 }] }

test('제안을 사장님 말로', () => {
  assert.equal(changeText({ path: 'budget_krw', label: '예산', unit: '원', current: 100000, suggested: 113280 }), '예산 100,000원 → 113,280원')
  assert.equal(changeText({ path: 'max_delivery_count', label: '배송 횟수', unit: '회', current: 1, suggested: 2 }), '배송 횟수 1번 → 2번')
  assert.equal(changeText({ path: 'items[0].storage_capacity', label: '원두 보관 한도', unit: 'g', current: 3000, suggested: 3500 }), '원두 보관 한도 3kg → 3.5kg')
})

test('제안대로 바꾼 새 입력을 만들고 원래 입력은 그대로 둔다', () => {
  const next = applyChanges(input, [
    { path: 'budget_krw', label: '예산', unit: '원', current: 100000, suggested: 113280 },
    { path: 'items[0].storage_capacity', label: '원두 보관 한도', unit: 'g', current: 3000, suggested: 3500 },
  ])
  assert.equal(next.budget_krw, 113280)
  assert.equal(next.items[0].storage_capacity, 3500)
  assert.equal(input.budget_krw, 100000)
  assert.equal(input.items[0].storage_capacity, 3000)
})

test('없는 품목이나 모르는 칸은 고르지 않는다', () => {
  assert.equal(applyChanges(input, [{ path: 'items[5].storage_capacity', label: '?', unit: 'g', current: 1, suggested: 2 }]), null)
  assert.deepEqual(usable([{ path: 'suppliers[0].minimum_order_krw', label: '최소 주문', unit: '원', current: 1, suggested: 2 }, { path: 'budget_krw', label: '예산', unit: '원', current: 1, suggested: 'x' }]), [])
})
