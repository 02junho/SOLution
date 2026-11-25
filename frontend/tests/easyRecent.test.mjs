import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanTitle, when } from '../src/features/easy/recentFormat.ts'

test('최근 업무 제목에서 [쉬운 화면] 같은 머리표를 뗀다', () => {
  assert.equal(cleanTitle('[쉬운 화면] 점심 인원 배치'), '점심 인원 배치')
  assert.equal(cleanTitle('이번 주 매입'), '이번 주 매입')
  assert.equal(cleanTitle('[시연] '), '이름 없는 업무')
})

test('오늘이면 시각, 아니면 날짜로 보인다', () => {
  const now = new Date(2026, 10, 20, 16, 0)
  assert.equal(when(new Date(2026, 10, 20, 15, 7).toISOString(), now), '오늘 15:07')
  assert.equal(when(new Date(2026, 10, 18, 9, 0).toISOString(), now), '11월 18일')
})

test('업무 조건을 한 줄로 요약해 같은 제목을 구분한다', async () => {
  const { inputSummary } = await import('../src/features/easy/recentFormat.ts')
  assert.equal(inputSummary('purchase', { budget_krw: 200000, max_delivery_count: 2, suppliers: [1, 2, 3] }), '예산 200,000원 · 배송 2번까지 · 거래처 3곳')
  assert.equal(inputSummary('purchase', { budget_krw: null }), '예산 안 정함')
  assert.equal(inputSummary('operation', { operation_form: { daily_orders: 276, is_owner_working: false } }), '바쁜 날(276건) · 직원만')
  assert.equal(inputSummary('operation', { other: 1 }), '자세한 화면에서 만든 조건')
  assert.equal(inputSummary('operation', null), '')
})
