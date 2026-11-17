import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { stateAt, simulationClock } from '../src/features/operation/replay.ts'

const sample = JSON.parse(readFileSync(new URL('../src/features/operation/demo.json', import.meta.url), 'utf8'))
const trace = sample.traces.find(t => t.choice_key === 'ALT_C')

test('워밍업 뒤의 초기 대기 고객을 지우지 않는다', () => {
  assert.equal(stateAt(trace, 0).customers.get('WARMUP_1'), 'WAITING_PREPARATION')
  assert.equal(stateAt(trace, 0).activeStaff.size, 2)
})
test('직원 투입·이탈은 customer_key가 null이어도 적용한다', () => {
  assert.equal(stateAt(trace, 1799).activeStaff.size, 2)
  assert.equal(stateAt(trace, 1800).activeStaff.size, 3)
  assert.equal(stateAt(trace, 9000).activeStaff.size, 2)
})
test('주문·제조·수령 단계를 순서대로 재생한다', () => {
  assert.equal(stateAt(trace, 1800).customers.get('CUSTOMER_1'), 'ORDER_QUEUE')
  assert.equal(stateAt(trace, 1812).customers.get('CUSTOMER_1'), 'ORDERING')
  assert.equal(stateAt(trace, 1822).customers.get('CUSTOMER_1'), 'PREPARING')
  assert.equal(stateAt(trace, 1942).customers.get('CUSTOMER_1'), 'WAITING_HANDOFF')
  assert.equal(stateAt(trace, 1946).customers.get('CUSTOMER_1'), 'DONE')
})
test('되감기는 초기 상태부터 재구성한다', () => {
  stateAt(trace, 9500)
  assert.equal(stateAt(trace, 0).completed, 0)
  assert.equal(stateAt(trace, 0).customers.has('CUSTOMER_1'), false)
})
test('같은 시각에는 sequence_no로 순서를 정한다', () => {
  const unsorted = { ...trace, events: [...trace.events].reverse() }
  assert.deepEqual(stateAt(unsorted, 1822), stateAt(trace, 1822))
})
test('중복 수령 이벤트로 완료 수가 두 번 늘지 않는다', () => {
  const done = trace.events.find(e => e.event_type === 'HANDED_OVER' && e.customer_key === 'CUSTOMER_1')
  const duplicated = { ...trace, events: [...trace.events, { ...done, sequence_no: 999 }] }
  assert.equal(stateAt(duplicated, 9500).completed, 2)
})
test('초기 이벤트와 객체를 변경하지 않는다', () => {
  const before = JSON.stringify(trace)
  stateAt(trace, 9500)
  assert.equal(JSON.stringify(trace), before)
})
test('모의 시각과 화면 배속은 별개다', () => {
  assert.equal(simulationClock('11:00:00', 1800), '11:30:00')
  assert.equal(simulationClock('11:00:00', 9000), '13:30:00')
})
test('초기 상태가 없는 이전 기록을 빈 매장 실측으로 단정하지 않는다', () => {
  const old = { ...trace, trace_schema_version: 'operation.trace.v1', initial_state: null }
  assert.equal(stateAt(old, 0).initialKnown, false)
  assert.equal(stateAt(old, 1946).customers.get('CUSTOMER_1'), 'DONE')
})
