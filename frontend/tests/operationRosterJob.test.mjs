// 추천 근무표 뒤에서 계산: 상태가 끝날 때까지 기다리기.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' })
const job = await server.ssrLoadModule('/src/features/operation/roster/rosterJob.ts')
after(async () => {
  await server.close()
})

test('끝날 때까지 상태를 확인하고, 실패하면 알린다', async () => {
  const states = ['RUNNING', 'RUNNING', 'DONE']
  const realFetch = globalThis.fetch
  const realTimeout = globalThis.setTimeout
  globalThis.setTimeout = (fn) => realTimeout(fn, 0)
  let calls = 0
  globalThis.fetch = async (url) => {
    assert.match(String(url), /\/api\/v1\/operation\/sessions\/12\/roster-results\?input_version_id=34&request_key=k/)
    const state = states[Math.min(calls++, states.length - 1)]
    const data = { state, session_id: 12, input_version_id: 34, ...(state === 'DONE' ? { result_id: 9, summary: { message: 'm' } } : {}) }
    return new Response(JSON.stringify({ status: 'ok', data, message: null }), { headers: { 'Content-Type': 'application/json' } })
  }
  try {
    const ticks = []
    const done = await job.waitRoster({ sessionId: 12, versionId: 34, key: 'k' }, (s) => ticks.push(s))
    assert.equal(done.result_id, 9)
    assert.equal(ticks.length, 2)
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ status: 'ok', data: { state: 'LOST', session_id: 12, input_version_id: 34 }, message: '다시 계산해 주세요.' }), {
        headers: { 'Content-Type': 'application/json' },
      })
    await assert.rejects(job.waitRoster({ sessionId: 12, versionId: 34, key: 'k' }, () => {}), /다시 계산/)
    const stopped = await job.waitRoster({ sessionId: 12, versionId: 34, key: 'k' }, () => {}, { stopped: true })
    assert.equal(stopped, null)
  } finally {
    globalThis.fetch = realFetch
    globalThis.setTimeout = realTimeout
  }
})
