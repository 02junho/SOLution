import { beforeEach, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { Window } from 'happy-dom'
import { createServer } from 'vite'
const testWindow = new Window({ url: 'http://localhost:5173/#/confirmations' })
globalThis.window = testWindow
globalThis.document = testWindow.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { ConfirmationHistory } = await server.ssrLoadModule('/src/features/workflow/History.tsx')
const { ConfirmationModal } = await server.ssrLoadModule('/src/features/workflow/Results.tsx')
const { default: App } = await server.ssrLoadModule('/src/App.tsx')
test.after(async () => { await server.close() })
const originalFetch = globalThis.fetch
const ok = (data) => new Response(JSON.stringify({ status: 'ok', data }), { headers: { 'Content-Type': 'application/json' } })
let root, container, calls, deleted, closes, fail
const plan = { confirmation_id: 3002, session_id: 500, feature_type: 'purchase', selected_choice_key: 'purchase_1', version_no: 1, is_current_version: true, confirmed_at: '2026-11-19T00:00:00Z' }
beforeEach(() => {
  calls = []; deleted = []; closes = 0; fail = false
  container = document.createElement('div'); document.body.append(container)
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'DELETE') {
      calls.push(url)
      return fail ? new Response(JSON.stringify({ status: 'error', data: null, message: '잠시 후 다시 시도해 주세요.' }), { status: 503 }) : ok({ confirmation_id: 3002 })
    }
    return url.endsWith('/3002')
      ? ok({ ...plan, acknowledged_warnings_json: [], selected_snapshot_json: { choice: { total_krw: 120400 } } })
      : ok({ items: [plan], next_cursor: null })
  }
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
const mount = async (Component) => { await act(async () => { root = createRoot(container); root.render(React.createElement(Component, { id: 3002, onOpen() {}, onClose() { closes++ }, onDeleted(id) { deleted.push(id) } })) }) }
const click = async (selector) => { const button = container.querySelector(selector); assert.ok(button, selector); await act(async () => button.click()) }

test('저장한 계획 목록에서 확인 후 삭제하고 취소하면 요청하지 않는다', async () => {
  await mount(ConfirmationHistory)
  assert.equal(container.querySelector('.confirmation-card button'), null)
  await click('.plan-delete > button')
  assert.match(container.textContent, /업무 대화와 계산 결과는 그대로/)
  await click('[aria-label="저장한 계획 삭제 확인"] .secondary')
  assert.equal(calls.length, 0)
  await click('.plan-delete > button')
  await click('[aria-label="저장한 계획 삭제 확인"] .primary')
  assert.deepEqual(calls, ['/api/v1/work-confirmations/3002'])
  assert.deepEqual(deleted, [3002])
  assert.equal(container.querySelector('.confirmation-entry'), null)
})

test('계획 상세에서 삭제 실패는 안내하고 성공할 때만 닫고 목록을 갱신한다', async () => {
  await mount(ConfirmationModal)
  await click('.plan-delete > button')
  fail = true
  await click('[aria-label="저장한 계획 삭제 확인"] .primary')
  assert.match(container.textContent, /잠시 후 다시 시도/)
  assert.equal(closes, 0)
  assert.deepEqual(deleted, [])
  fail = false
  await click('[aria-label="저장한 계획 삭제 확인"] .primary')
  assert.deepEqual(deleted, [3002])
  assert.equal(closes, 1)
})

for (const via of ['list', 'detail']) {
  test(`계획 ${via === 'list' ? '목록' : '상세'}에서 삭제해도 필터와 불러온 페이지·다음 커서를 유지한다`, async () => {
    window.location.hash = '/confirmations'
    const readUrls = []
    const plans = [3001, 3002, 3003, 3004].map((id) => ({ ...plan, confirmation_id: id }))
    globalThis.fetch = async (url, init) => {
      if (init?.method === 'DELETE') return ok({ confirmation_id: 3002 })
      if (url.endsWith('/3002')) return ok({ ...plans[1], acknowledged_warnings_json: [], selected_snapshot_json: { choice: { total_krw: 120400 } } })
      readUrls.push(url)
      const search = new URL(url, 'http://localhost').searchParams
      if (search.get('cursor') === 'older-2') return ok({ items: [plans[3]], next_cursor: null })
      if (search.get('cursor') === 'older') return ok({ items: [plans[2]], next_cursor: 'older-2' })
      return ok({ items: plans.slice(0, 2), next_cursor: 'older' })
    }
    await mount(App)
    const clickText = async (text) => {
      const button = [...container.querySelectorAll('button')].find((b) => b.textContent.trim() === text)
      assert.ok(button, text)
      await act(async () => button.click())
    }
    await clickText('매입·재고')
    await clickText('계획 더 보기')
    assert.equal(container.querySelectorAll('.confirmation-entry').length, 3)
    if (via === 'detail') await act(async () => container.querySelectorAll('.confirmation-card')[1].click())
    else await click('[aria-label="저장 번호 3002 계획 삭제"]')
    if (via === 'detail') await click('.confirmation-detail .plan-delete > button')
    await click('[aria-label="저장한 계획 삭제 확인"] .primary')
    assert.equal(container.querySelector('dialog'), null)
    assert.equal(container.querySelector('.filter-tabs button.active')?.textContent.trim(), '매입·재고')
    assert.equal(container.querySelector('[aria-label="저장 번호 3002 계획 삭제"]'), null)
    for (const id of [3001, 3003]) assert.ok(container.querySelector(`[aria-label="저장 번호 ${id} 계획 삭제"]`))
    assert.equal(readUrls.length, 3, '삭제 때문에 첫 페이지를 다시 읽지 않는다')
    await clickText('계획 더 보기')
    assert.equal(new URL(readUrls.at(-1), 'http://localhost').searchParams.get('cursor'), 'older-2')
    assert.ok(container.querySelector('[aria-label="저장 번호 3004 계획 삭제"]'))
  })
}
