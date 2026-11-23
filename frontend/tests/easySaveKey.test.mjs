import assert from 'node:assert/strict'
import test from 'node:test'
import { forgetSaves, saveKey } from '../src/features/easy/saveKey.ts'

test('같은 결과·버전·안·확인 항목이면 다시 눌러도 같은 저장 키', () => {
  const first = saveKey(7001, 11, 'purchase_1', ['w2', 'w1'])
  assert.equal(saveKey(7001, 11, 'purchase_1', ['w1', 'w2']), first, '확인 항목 순서는 상관없다')
  assert.notEqual(saveKey(7001, 11, 'purchase_2', ['w1', 'w2']), first, '다른 안이면 다른 키')
  assert.notEqual(saveKey(7001, 12, 'purchase_1', ['w1', 'w2']), first, '조건 버전이 바뀌면 다른 키')
})

test('저장한 계획을 지우면 그 결과의 키를 새로 만든다', () => {
  const before = saveKey(7002, 3, 'ALT_A', [])
  assert.equal(saveKey(7002, 3, 'ALT_A', []), before)
  forgetSaves(7002)
  assert.notEqual(saveKey(7002, 3, 'ALT_A', []), before)
})
