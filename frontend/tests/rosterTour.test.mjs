import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ROSTER_TOUR_TOTAL, rosterStep } from '../src/features/operation/easy/rosterTour.ts'

test('근무표 따라 하며 배우기: 데이터 고르기 → 조건 확인 → 결과 4단계, 계산 중엔 숨김', () => {
  assert.equal(rosterStep('start', null, 0).number, 1)
  assert.equal(rosterStep('confirm', 'pick', 0).step.target, 'source')
  assert.equal(rosterStep('confirm', 'confirm', 0).step.target, 'confirm-area') // 조건 카드 + 말로 고치기 칸
  assert.equal(rosterStep('running', null, 0), null)
  const targets = [0, 1, 2, 3].map((i) => rosterStep('result', null, i).step.target)
  assert.deepEqual(targets, ['verdict', 'detail', 'compare', 'save'])
  assert.equal(rosterStep('result', null, 9).number, ROSTER_TOUR_TOTAL) // 넘어가도 마지막 단계
})
