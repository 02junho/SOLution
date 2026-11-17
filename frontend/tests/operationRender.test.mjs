import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { default: Panel } = await server.ssrLoadModule('/src/features/operation/OperationResultPanel.tsx')
const sample = JSON.parse(readFileSync(new URL('../src/features/operation/demo.json', import.meta.url), 'utf8'))
const props = { loadingDetail: false, onDetail() {}, trace: null, loadingTrace: false, onTrace() {} }
test.after(async () => { await server.close() })

test('세 비교 카드와 모의 조건·비용 범위를 실제 컴포넌트가 렌더링한다', () => {
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result: sample.result, preview: true }))
  assert.equal((html.match(/class="op-plan-card/g) ?? []).length, 3)
  for (const value of ['모의 조건', '82,560원', '103,200원', '20,640원', '기본급 기준', '미리보기에서는 저장하지 않습니다.']) assert.ok(html.includes(value))
})
test('지정된 비교 지표와 0을 포함한 구간의 표시가 일치한다', () => {
  const result = structuredClone(sample.result)
  result.summary.choices[1].comparison.metric = 'total_time_p90_seconds'
  result.summary.choices[1].comparison.ci95_lower_seconds = -1
  result.summary.choices[1].comparison.ci95_upper_seconds = 1
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  assert.ok(html.includes('총 소요 p90 차이'))
  assert.ok(html.includes('차이 없음'))
})
test('정보 부족 결과를 성공 카드로 그리지 않는다', () => {
  const result = structuredClone(sample.result)
  result.response_status = 'needs_input'
  result.summary = { missing_fields: [{ path: 'labor.weekly_context', label: '주간 근무 조건', unit: null }], recommendation: null }
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  assert.equal((html.match(/class="op-plan-card/g) ?? []).length, 0)
  assert.ok(html.includes('주간 근무 조건'))
})
test('미확인 금액과 실제 0원을 구분한다', () => {
  const result = structuredClone(sample.result)
  result.summary.choices[0].monthly_cash_cost_estimate_krw = null
  result.summary.choices[0].additional_monthly_cash_cost_estimate_krw = null
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  assert.ok(html.includes('미확인'))
  assert.ok(html.includes('0원'))
})
test('배치 요약을 대기·비용보다 먼저 보여주고 2시간 추가 인력을 명시한다', () => {
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result: sample.result }))
  assert.ok(html.indexOf('op-staffing-summary') < html.indexOf('op-primary-metric'))
  assert.ok(html.includes('11:30–13:30'))
  assert.ok(html.includes('최대 3명'))
})
test('이전 저장 결과에는 배치 요약 대신 전체 배치표 안내를 보여준다', () => {
  const result = structuredClone(sample.result)
  result.summary.choices.forEach(plan => { delete plan.staffing_summary })
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  assert.ok(html.includes('인원·역할 요약이 없는 이전 결과'))
})
test('구버전 결과와 미리보기의 확정 버튼을 잠근다', () => {
  const result = structuredClone(sample.result)
  result.is_latest_version = false
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  assert.ok(html.includes('조건이 바뀐 예전 결과'))
  assert.match(html, /<button disabled="">이 안으로 확정<\/button>/)
})

test('마감 판정 미제공을 성공으로 표시하지 않는다', () => {
  const result = structuredClone(sample.result)
  result.summary.choices.forEach(p => { delete p.closing })
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  assert.equal((html.match(/마감 판정 미제공/g) ?? []).length, 3)
  assert.ok(!html.includes('성공 비율'))
})
test('확인된 역할·지원 가능 업무·배치시간과 마감 결과를 표시한다', () => {
  const result = structuredClone(sample.result)
  result.summary.choices[2].closing = { failed_repetitions: 3, success_ratio: 0.9 }
  result.summary.choices[2].staffing_summary.total_staff_hours = 24
  result.summary.choices[2].staffing_summary.assignments[0] = {
    worker_key: 'A', is_owner: true, task_code: 'ORDER', primary_role: 'ORDER', can_support: ['MAKE'], start_time: '11:00', end_time: '14:00'
  }
  const html = renderToStaticMarkup(createElement(Panel, { ...props, result }))
  for (const label of ['마감 실패 3회', '성공 비율 90.0%', '총 배치시간 24시간', '휴게 차감 전', '주문 우선', '제조·전달 지원 가능', '사장님 · 11:00–14:00']) assert.ok(html.includes(label), label)
})
