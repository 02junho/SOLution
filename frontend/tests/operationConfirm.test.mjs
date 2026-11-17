// 운영 결과 확정 버튼을 실제로 눌러 보는 검사 (happy-dom).
// 정적 렌더링 검사(operationRender)로는 "안 선택 + 필수 경고 체크" 상태를 만들 수 없어서 따로 둔다.
import { afterEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import React, { act } from 'react'
import { Window } from 'happy-dom'
import { createServer } from 'vite'

const testWindow = new Window()
globalThis.window = testWindow
globalThis.document = testWindow.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const { default: Panel } = await server.ssrLoadModule('/src/features/operation/OperationResultPanel.tsx')
const { CHOICE_LABELS } = await server.ssrLoadModule('/src/features/operation/types.ts')
const sample = JSON.parse(readFileSync(new URL('../src/features/operation/demo.json', import.meta.url), 'utf8'))
after(async () => { await server.close() })

const saved = { status: 'ok', data: { confirmation_id: 3001, is_current_version: true }, message: null }
let mounted = []
afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount())
    container.remove()
  }
  mounted = []
})

async function mount(result, onConfirm = async () => saved) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(React.createElement(Panel, {
    result, loadingDetail: false, onDetail() {}, trace: null, loadingTrace: false, onTrace() {}, onConfirm,
  })))
  mounted.push({ root, container })
  return container
}
const buttons = c => [...c.querySelectorAll('button')]
const confirmButton = c => buttons(c).find(b => /확정|저장 중/.test(b.textContent))
const selectButtons = c => buttons(c).filter(b => b.getAttribute('aria-pressed') !== null)
async function click(element) { await act(async () => element.click()) }
async function chooseFirstAndAcknowledge(c) {
  await click(selectButtons(c)[0])
  for (const box of c.querySelectorAll('input[type="checkbox"]')) await click(box)
}

test('대조군: 최신·complete true 결과는 안을 고르고 필수 경고를 확인해야 확정 버튼이 켜진다', async () => {
  const c = await mount(structuredClone(sample.result))
  assert.equal(confirmButton(c).disabled, true)
  await click(selectButtons(c)[0])
  assert.equal(confirmButton(c).disabled, true, '필수 경고(모의 조건)를 확인하기 전에는 꺼져 있어야 한다')
  for (const box of c.querySelectorAll('input[type="checkbox"]')) await click(box)
  assert.equal(confirmButton(c).disabled, false)
})

const blocked = {
  '조건이 바뀐 예전 결과': r => { r.is_latest_version = false },
  'complete가 false': r => { r.summary.complete = false },
  'complete가 없음': r => { delete r.summary.complete },
  'complete가 문자열 "true"': r => { r.summary.complete = 'true' },
}
for (const [name, change] of Object.entries(blocked)) {
  test(`${name}이면 같은 준비를 해도 확정 버튼이 꺼져 있다`, async () => {
    const result = structuredClone(sample.result)
    change(result)
    const c = await mount(result)
    await chooseFirstAndAcknowledge(c)
    assert.equal(confirmButton(c).disabled, true)
  })
}

test('저장 중에는 안을 바꿀 수 없고, 실제로 보낸 안을 확정됨으로 표시한다', async () => {
  const result = structuredClone(sample.result)
  const [first, second] = result.summary.choices.map(row => row.choice_key)
  let finish
  const sent = []
  const c = await mount(result, (choice, ids) => {
    sent.push({ choice, ids })
    return new Promise(resolve => { finish = resolve })
  })
  await chooseFirstAndAcknowledge(c)
  await click(confirmButton(c))
  assert.equal(confirmButton(c).textContent, '저장 중…')
  await click(selectButtons(c)[1])
  assert.equal(selectButtons(c)[1].getAttribute('aria-pressed'), 'false', '저장 중에는 다른 안을 고를 수 없다')
  await act(async () => finish(saved))
  assert.deepEqual(sent, [{ choice: first, ids: ['SIMULATED_CONDITIONS'] }])
  assert.equal(confirmButton(c).textContent, `${CHOICE_LABELS[first]} 확정됨`)
  assert.notEqual(first, second)
})
