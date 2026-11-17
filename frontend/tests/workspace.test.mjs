import { afterEach, beforeEach, test } from 'node:test'
import assert from 'node:assert/strict'
import React, { act } from 'react'
import { Window } from 'happy-dom'
const testWindow = new Window()
globalThis.window = testWindow
globalThis.document = testWindow.document
const { createRoot } = await import('react-dom/client')
import { useWorkspace } from '../src/features/workflow/useWorkspace.ts'

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let current, root, version, confirmations, post, requests
const originalFetch = globalThis.fetch
const ok = (data, message = null) =>
  new Response(JSON.stringify({ status: 'ok', data, message }), {
    headers: { 'Content-Type': 'application/json' },
  })
function Harness() {
  const value = useWorkspace()
  React.useLayoutEffect(() => {
    current = value
  })
  return React.createElement('div')
}
beforeEach(async () => {
  version = 1
  confirmations = []
  requests = []
  globalThis.fetch = async (url, init) => {
    if (init?.method === 'POST') {
      requests.push({
        url,
        body: JSON.parse(init.body),
        key: init.headers.get('X-Request-Key'),
      })
      return post()
    }
    if (url.includes('/messages')) return ok({ items: [], next_cursor: null })
    if (url.includes('/work-confirmations'))
      return ok({ items: confirmations, next_cursor: null })
    const id = Number(url.split('/').at(-1))
    return ok({
      session_id: id,
      current_version: version,
      current_version_id: version * 10,
      feature_type: 'purchase',
      latest_result_id: null,
    })
  }
  await act(async () => {
    root = createRoot(document.createElement('div'))
    root.render(React.createElement(Harness))
  })
  await act(async () => {
    await current.open(1)
  })
})
afterEach(async () => {
  await act(async () => root.unmount())
  globalThis.fetch = originalFetch
})
const form = { event_type: 'form', form_input: { budget_krw: 150000 } }

test('응답 유실 후 재조회가 새 버전을 읽어도 원래 본문과 키로 재전송한다', async () => {
  let calls = 0
  post = async () => {
    if (++calls === 1) {
      version = 2
      throw new Error('응답 유실')
    }
    return ok({ input_version_id: 20 })
  }
  await act(async () => {
    assert.equal(await current.event(form), false)
  })
  assert.equal(current.context.current_version_id, 20)
  assert.equal(current.pendingEvent, true)
  await act(async () => {
    assert.equal(await current.retryEvent(), true)
  })
  assert.deepEqual(requests[0], requests[1])
  assert.equal(requests[1].body.base_version_id, 10)
  assert.equal(current.pendingEvent, false)
  assert.equal(version, 2)
})
test('미확인 입력이 있으면 새로운 입력·계산을 보내지 않고 기존 요청부터 확인한다', async () => {
  post = async () => {
    throw new Error('응답 유실')
  }
  await act(async () => {
    await current.event(form)
  })
  await act(async () => {
    await current.event({ ...form, form_input: { budget_krw: 999 } })
    await current.calculate()
  })
  assert.equal(requests.length, 1)
  assert.equal(current.pendingEvent, true)
})
test('저장되지 않은 요청이 STALE_INPUT이면 재전송을 종료하고 최신 입력 검토를 안내한다', async () => {
  post = async () => {
    throw new Error('응답 유실')
  }
  await act(async () => {
    await current.event(form)
  })
  version = 2
  post = async () =>
    new Response(
      JSON.stringify({
        status: 'error',
        data: null,
        message: '조건이 바뀌었어요. 최신 입력을 불러온 뒤 다시 보내 주세요.',
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    )
  await act(async () => {
    assert.equal(await current.retryEvent(), false)
  })
  assert.equal(current.pendingEvent, false)
  assert.equal(current.context.current_version_id, 20)
  assert.match(current.error, /저장되지 않았고/)
  assert.deepEqual(requests[0], requests[1])
  post = async () => {
    version = 3
    return ok({ input_version_id: 30 })
  }
  await act(async () => {
    await current.event({ ...form, form_input: { budget_krw: 160000 } })
  })
  assert.equal(requests[2].body.base_version_id, 20)
  assert.notEqual(requests[2].key, requests[1].key)
})
test('잠금 중 요청한 마지막 업무는 잠금 해제 후 열고 이전 업무 응답은 화면에 덮지 않는다', async () => {
  let finish
  post = () =>
    new Promise((resolve) => {
      finish = () => resolve(ok({ input_version_id: 10 }))
    })
  let action
  await act(async () => {
    action = current.event(form)
    await Promise.resolve()
  })
  await act(async () => {
    await current.open(2)
    await current.open(3)
  })
  assert.equal(current.context, null)
  await act(async () => {
    finish()
    await action
  })
  assert.equal(current.context.session_id, 3)
  assert.equal(current.busy, '')
})
test('별도 조회가 서로 다른 시점이면 다른 버전의 확정을 현재 선택안으로 복원하지 않는다', async () => {
  confirmations = [
    { is_current_version: true, version_no: 2, confirmation_id: 9 },
  ]
  await act(async () => {
    await current.open(1)
  })
  assert.equal(current.saved, null)
  confirmations = [
    { is_current_version: true, version_no: 1, confirmation_id: 8 },
  ]
  await act(async () => {
    await current.open(1)
  })
  assert.equal(current.saved.confirmation_id, 8)
})
