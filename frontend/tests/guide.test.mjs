// 사용법 카드를 실제로 넘겨 보는 검사 (happy-dom).
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
const { default: GuideCards } = await server.ssrLoadModule('/src/features/guide/GuideCards.tsx')
const { GUIDE_SLIDES, guideAutoOpen, guideSeen, markGuideSeen } = await server.ssrLoadModule('/src/features/guide/guideSlides.ts')
after(async () => { await server.close() })

let mounted = []
afterEach(async () => {
  for (const { root, container } of mounted) {
    await act(async () => root.unmount())
    container.remove()
  }
  mounted = []
})

async function mount(calls) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => root.render(React.createElement(GuideCards, {
    onClose: () => calls.push('close'),
    onStart: () => calls.push('start'),
  })))
  mounted.push({ root, container })
  return container
}
const button = (c, text) => [...c.querySelectorAll('.guide-footer button')].find(b => b.textContent.includes(text))
const title = c => c.querySelector('.guide-title').textContent
async function click(element) { await act(async () => element.click()) }

test('카드 4장을 다음으로 넘기고 마지막에서 첫 업무 시작하기를 누른다', async () => {
  const calls = []
  const c = await mount(calls)
  assert.equal(GUIDE_SLIDES.length, 4)
  for (const slide of GUIDE_SLIDES.slice(0, -1)) {
    assert.equal(title(c), slide.title)
    await click(button(c, '다음'))
  }
  assert.equal(title(c), GUIDE_SLIDES.at(-1).title)
  assert.equal(button(c, '다음'), undefined)
  await click(button(c, '첫 업무 시작하기'))
  assert.deepEqual(calls, ['start'])
})

test('카드가 바뀌면 낭독 영역에 번호와 제목을 알리고, 넘겨도 같은 버튼에 포커스가 남는다', async () => {
  const c = await mount([])
  const live = c.querySelector('[aria-live="polite"]')
  assert.ok(live)
  assert.match(live.textContent, /^1 \/ 4 /)
  const next = c.querySelector('.guide-footer .primary')
  const back = c.querySelector('.guide-footer .secondary')
  next.focus()
  for (let i = 1; i < GUIDE_SLIDES.length; i++) {
    await click(next)
    assert.equal(c.querySelector('.guide-footer .primary'), next, '마지막 장에서도 같은 버튼')
    assert.equal(document.activeElement, next)
    assert.ok(live.isConnected && c.querySelector('[aria-live="polite"]') === live, '낭독 영역은 교체되지 않는다')
    assert.ok(live.textContent.startsWith(`${i + 1} / 4 ${GUIDE_SLIDES[i].eyebrow}`))
  }
  assert.match(next.textContent, /첫 업무 시작하기/)
  back.focus()
  await click(back)
  assert.equal(document.activeElement, back)
})

test('첫 장의 건너뛰기는 닫고, 이전·점으로 원하는 장에 간다', async () => {
  const calls = []
  const c = await mount(calls)
  const dots = [...c.querySelectorAll('.guide-dots button')]
  assert.equal(dots.length, 4)
  await click(dots[2])
  assert.equal(title(c), GUIDE_SLIDES[2].title)
  await click(button(c, '이전'))
  assert.equal(title(c), GUIDE_SLIDES[1].title)
  await click(button(c, '이전'))
  await click(button(c, '건너뛰기'))
  assert.deepEqual(calls, ['close'])
})

test('한 번 보면 다음 방문에는 자동으로 열리지 않는다', () => {
  window.localStorage.clear()
  assert.equal(guideSeen(), false)
  markGuideSeen()
  assert.equal(guideSeen(), true)
})

test('처음 방문이면 업무 첫 화면에서만 자동으로 열고, 다른 주소로 바로 오면 열지 않는다', () => {
  window.localStorage.removeItem('solution.guide.seen')
  for (const hash of ['', '#', '#/', '#/work']) assert.equal(guideAutoOpen(hash), true, hash)
  for (const hash of ['#/work/12', '#/confirmations', '#/system', '#/operation']) assert.equal(guideAutoOpen(hash), false, hash)
  markGuideSeen()
  assert.equal(guideAutoOpen('#/work'), false)
})
