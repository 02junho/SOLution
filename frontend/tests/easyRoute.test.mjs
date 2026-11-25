import assert from 'node:assert/strict'
import test from 'node:test'
import { changedSegments, guessFeature, perHundred, segmentKey } from '../src/features/easy/route.ts'

test('첫 마디로 장보기(매입)와 점심 인원(운영)을 가른다', () => {
  assert.equal(guessFeature('점심에 알바 한 명 더 쓰면 어때?'), 'operation')
  assert.equal(guessFeature('손님이 몰려서 줄이 길어요'), 'operation')
  assert.equal(guessFeature('이번 주 장보기 계획 세워 줘'), 'purchase')
  assert.equal(guessFeature('우유랑 원두 어디서 사야 싸요?'), 'purchase')
  assert.equal(guessFeature('안녕하세요'), null)
})

test('손님 비율을 100명 중 몇 명으로 말한다', () => {
  assert.equal(perHundred(0.0368), '100명 중 약 4명')
  assert.equal(perHundred(0.0007), '100명 중 1명도 안 돼요')
  assert.equal(perHundred(null), '—')
})

test('추천 배치에서 지금과 달라진 구간만 고른다', () => {
  const current = [
    { worker_key: 'OWNER', start_time: '07:00', end_time: '19:00', task_code: 'ORDER_HANDOFF' },
    { worker_key: 'STAFF_1', start_time: '07:00', end_time: '19:00', task_code: 'PREPARATION' },
  ]
  const next = [
    current[0], current[1],
    { worker_key: 'STAFF_2', start_time: '11:00', end_time: '14:00', task_code: 'PREPARATION_HELP_ORDER_HANDOFF' },
  ]
  const changed = changedSegments(current, next)
  assert.equal(changed.size, 1)
  assert.ok(changed.has(segmentKey(next[2])))

  // 서로 돕기: 구간만 나뉜 07~11시·14~19시는 그대로, 일이 바뀐 11~14시만 바뀜
  const helping = [
    { worker_key: 'OWNER', start_time: '07:00', end_time: '11:00', task_code: 'ORDER_HANDOFF' },
    { worker_key: 'OWNER', start_time: '11:00', end_time: '14:00', task_code: 'ORDER_HANDOFF_HELP_PREPARATION' },
    { worker_key: 'OWNER', start_time: '14:00', end_time: '19:00', task_code: 'ORDER_HANDOFF' },
  ]
  assert.deepEqual([...changedSegments(current, helping)], [segmentKey(helping[1])])
})
