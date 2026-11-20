// 창 바깥(배경)을 누르면 닫히는지: 읽기 창만 켜고, 입력 창은 그대로 둔다 (happy-dom).
import { afterEach, after, test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { Window } from 'happy-dom'
import { createServer } from 'vite'

const testWindow = new Window()
globalThis.window = testWindow
globalThis.document = testWindow.document
globalThis.IS_REACT_ACT_ENVIRONMENT = true
const { createRoot } = await import('react-dom/client')

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const { Modal } = await server.ssrLoadModule('/src/components/common/Ui.tsx')
after(async () => { await server.close() })

let mounted = []
afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount())
    container.remove()
  }
  mounted = []
})

async function mount(props) {
  const calls = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(React.createElement(Modal, {
    title: '창', onClose: () => calls.push('close'), ...props,
  }, React.createElement('p', { id: 'inside' }, '내용'))))
  mounted.push({ root, container })
  // happy-dom은 크기가 0이라, 창 상자를 직접 정한다.
  const dialog = container.querySelector('dialog')
  dialog.getBoundingClientRect = () => ({ left: 100, right: 300, top: 100, bottom: 300 })
  return { dialog, calls, inside: container.querySelector('#inside') }
}
async function press(downOn, upOn, x, y) {
  await act(async () => {
    downOn.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true, clientX: x, clientY: y }))
    upOn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, clientX: x, clientY: y }))
  })
}

test('closeOnBackdrop이면 배경을 눌렀을 때 닫는다', async () => {
  const { dialog, calls } = await mount({ closeOnBackdrop: true })
  await press(dialog, dialog, 20, 20)
  assert.deepEqual(calls, ['close'])
})

test('closeOnBackdrop이 없으면(입력 창) 배경을 눌러도 닫지 않는다', async () => {
  const { dialog, calls } = await mount({})
  await press(dialog, dialog, 20, 20)
  assert.deepEqual(calls, [])
})

test('창 안을 누르거나, 안에서 눌러 밖에서 떼면 닫지 않는다', async () => {
  const { dialog, calls, inside } = await mount({ closeOnBackdrop: true })
  await press(inside, inside, 150, 150)
  await press(inside, dialog, 20, 20)
  assert.deepEqual(calls, [])
})
