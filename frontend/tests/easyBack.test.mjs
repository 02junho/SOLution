import assert from 'node:assert/strict'
import test from 'node:test'
import { backOf } from '../src/features/easy/back.ts'

const state = (over) => ({ phase: 'start', route: 'home', hasResult: false, resumed: false, hasFeature: false, ...over })

test('새로 시작하는 흐름: 단계마다 한 칸씩 뒤로 간다', () => {
  assert.equal(backOf(state({})), null, '첫 화면에는 뒤로 갈 곳이 없다')
  assert.deepEqual(backOf(state({ phase: 'ask' })).action, { kind: 'phase', phase: 'start', clearChat: true })
  assert.equal(backOf(state({ phase: 'confirm', hasFeature: true })).label, '다시 말하기')
  const running = backOf(state({ phase: 'running', hasFeature: true }))
  assert.equal(running.label, '계산 그만두기')
  assert.equal(running.action.cancelRun, true)
  assert.equal(backOf(state({ phase: 'result', route: 'session', hasFeature: true, hasResult: true })).label, '조건 다시 보기')
  assert.deepEqual(backOf(state({ phase: 'confirm', route: 'session', hasFeature: true, hasResult: true })).action, { kind: 'phase', phase: 'result' })
})

test('하던 일에서 연 업무: 조건 확인 앞은 하던 일 목록', () => {
  assert.equal(backOf(state({ phase: 'confirm', route: 'session', resumed: true, hasFeature: true })).label, '하던 일 목록')
  assert.equal(backOf(state({ phase: 'loading', route: 'session' })).label, '하던 일 목록')
  assert.equal(backOf(state({ phase: 'error', route: 'session' })).label, '하던 일 목록')
})

test('목록과 저장한 계획', () => {
  assert.deepEqual(backOf(state({ route: 'sessions' })).action, { kind: 'route', route: { kind: 'home' } })
  assert.deepEqual(backOf(state({ route: 'plans' })).action, { kind: 'route', route: { kind: 'home' } })
  assert.deepEqual(backOf(state({ route: 'plan', phase: 'result', hasResult: true })).action, { kind: 'route', route: { kind: 'plans' } })
})

test('어느 단계든 막다른 곳이 없다(첫 화면만 빼고)', () => {
  const phases = ['start', 'ask', 'confirm', 'running', 'result', 'error', 'loading']
  const routes = ['home', 'session', 'sessions', 'plans', 'plan']
  for (const route of routes) {
    for (const phase of phases) {
      for (const hasResult of [false, true]) {
        const back = backOf(state({ route, phase, hasResult, hasFeature: phase !== 'start', resumed: route === 'session' }))
        if (route === 'home' && phase === 'start') assert.equal(back, null)
        else assert.ok(back, `${route}/${phase}에서 뒤로 갈 곳이 있어야 한다`)
      }
    }
  }
})
