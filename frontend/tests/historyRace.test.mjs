import { beforeEach, afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { Window } from 'happy-dom'
import { createServer } from 'vite'
const testWindow = new Window()
globalThis.window = testWindow
globalThis.document = testWindow.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')
const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { SessionHistory } = await server.ssrLoadModule('/src/features/workflow/History.tsx')
test.after(async () => { await server.close() })
const originalFetch = globalThis.fetch
const ok = (data) => new Response(JSON.stringify({ status: 'ok', data }), { headers: { 'Content-Type': 'application/json' } })
const row = (id) => ({ session_id: id, title: `업무 ${id}`, feature_type: 'purchase', current_version: 1, step: 'input', updated_at: '2026-11-19T00:00:00Z' })
let root, container, finish, opened
beforeEach(async () => {
  let reads = 0
  opened = []
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'DELETE') return ok({ session_id: 1 })
    if (++reads === 1) return ok({ items: [row(1)], next_cursor: 'next' })
    return new Promise((resolve) => { finish = () => resolve(ok({ items: [row(1), row(2)], next_cursor: null })) })
  }
  container = document.createElement('div')
  document.body.append(container)
  await act(async () => { root = createRoot(container); root.render(React.createElement(SessionHistory, { onClose() {}, onSelect(id) { opened.push(id) } })) })
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); globalThis.fetch = originalFetch })
const clickText = async (text) => {
  const button = [...container.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
  assert.ok(button, text)
  await act(async () => button.click())
}
const confirmDelete = async () => {
  await act(async () => container.querySelector('[aria-label="업무 삭제 확인"] .primary').click())
}

test('삭제 중 진행하던 더 보기의 오래된 응답이 삭제 업무를 복원하지 않는다', async () => {
  await clickText('업무 더 보기')
  await clickText('대화 기록 삭제')
  await confirmDelete()
  await act(async () => finish())
  assert.equal(container.querySelector('[aria-label="업무 1 대화 기록 삭제"]'), null)
  assert.ok(container.querySelector('[aria-label="업무 2 대화 기록 삭제"]'))
  await act(async () => container.querySelector('.history-row').click())
  assert.deepEqual(opened, [2])
})

test('삭제 확인 중 필터 조회가 시작돼도 늦은 첫 페이지에서 삭제 업무를 제외한다', async () => {
  await clickText('대화 기록 삭제')
  await clickText('매입·재고')
  await confirmDelete()
  await act(async () => finish())
  assert.equal(container.querySelector('[aria-label="업무 1 대화 기록 삭제"]'), null)
  assert.ok(container.querySelector('[aria-label="업무 2 대화 기록 삭제"]'))
})
