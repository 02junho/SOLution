import assert from 'node:assert/strict'
import test from 'node:test'
import { currentStep, TOUR_TOTAL } from '../src/features/easy/tour.ts'

test('따라 하며 배우기는 화면 상태에 맞춰 단계를 고른다', () => {
  assert.equal(currentStep('start', null, 0).step.target, 'input')
  assert.equal(currentStep('start', null, 0).step.waitsForAction, true)
  assert.equal(currentStep('ask', null, 0).step.target, 'choices')
  assert.equal(currentStep('confirm', 'operation', 0).number, 2)
  // 계산 중·오류에는 가이드를 숨긴다
  assert.equal(currentStep('running', 'operation', 0), null)
  assert.equal(currentStep('error', 'purchase', 0), null)
})

test('결과 화면에서는 추천 → 자세히 → 저장 순서로 넘기고 마지막이 5단계다', () => {
  const op = [0, 1, 2].map((i) => currentStep('result', 'operation', i))
  assert.deepEqual(op.map((s) => s.step.target), ['verdict', 'detail', 'save'])
  assert.deepEqual(op.map((s) => s.number), [3, 4, 5])
  assert.equal(op[2].number, TOUR_TOTAL)
  assert.match(currentStep('result', 'operation', 1).step.title, /몇 시/)
  assert.match(currentStep('result', 'purchase', 1).step.title, /문구/)
  // 넘쳐도 마지막 단계에 머문다
  assert.equal(currentStep('result', 'purchase', 9).number, 5)
})
