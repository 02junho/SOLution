import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from '../src/api/client.ts'
import { workflowApi } from '../src/api/workflowApi.ts'
import {
  applicableWarnings,
  confirmationKey,
  currentInput,
  currentQuestion,
  questionDraft,
  RequestKeys,
  resolveChoice,
} from '../src/features/workflow/model.ts'

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

test('HTTP 500 응답이 ok를 주장해도 성공으로 처리하지 않는다', async () => {
  globalThis.fetch = async () =>
    json({ status: 'ok', data: {}, message: '실패' }, 500)
  assert.equal((await request('/v1/test')).status, 'error')
})
test('정상 needs_input/infeasible 응답을 오류와 구분한다', async () => {
  for (const status of ['needs_input', 'infeasible']) {
    globalThis.fetch = async () =>
      json({ status, data: { reason: '조건 확인' }, message: '확인해 주세요' })
    assert.equal((await request('/v1/test')).status, status)
  }
})
test('잘못된 응답과 연결 오류에 서버 원문을 노출하지 않는다', async () => {
  globalThis.fetch = async () => json({ password: 'private' })
  assert.equal((await request('/v1/test')).status, 'error')
  globalThis.fetch = async () => {
    throw new Error('private transport detail')
  }
  assert.ok(!(await request('/v1/test')).message.includes('private'))
})
test('최종 저장은 Spring 경로와 Idempotency-Key, 확인한 경고만 전송한다', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/v1/work-results/2001/confirm')
    assert.equal(init.headers.get('Idempotency-Key'), 'stable-key')
    assert.deepEqual(JSON.parse(init.body), {
      expected_input_version_id: 1002,
      selected_choice_key: 'purchase_1',
      acknowledged_warning_ids: ['A', 'VAT_UNKNOWN'],
    })
    return json({
      status: 'ok',
      data: { confirmation_id: 3001 },
      message: null,
    })
  }
  assert.equal(
    (
      await workflowApi.confirm(
        2001,
        1002,
        'purchase_1',
        ['VAT_UNKNOWN', 'A'],
        'stable-key',
      )
    ).confirmation_id,
    3001,
  )
})
test('대화 이벤트는 같은 X-Request-Key를 전달하고 needs_input을 유지한다', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(url, '/api/v1/work-sessions/100/events')
    assert.equal(init.headers.get('X-Request-Key'), 'event-key')
    return json({
      status: 'needs_input',
      data: { question_id: 'q_1' },
      message: '재고인가요?',
    })
  }
  assert.equal(
    (
      await workflowApi.event(
        100,
        { event_type: 'message', content: '우유 2L' },
        'event-key',
      )
    ).status,
    'needs_input',
  )
})
test('업무 복원은 대화 커서의 다음 페이지도 읽는다', async () => {
  let count = 0
  globalThis.fetch = async (url) => {
    count++
    if (count === 1)
      return json({
        status: 'ok',
        data: { items: [{ message_id: 1 }], next_cursor: '1' },
      })
    assert.ok(url.includes('cursor=1'))
    return json({
      status: 'ok',
      data: { items: [{ message_id: 2 }], next_cursor: null },
    })
  }
  assert.deepEqual(
    (await workflowApi.allMessages(100)).map((item) => item.message_id),
    [1, 2],
  )
})
test('실패 후 재시도 키는 같고 성공 처리 후 새 작업 키는 다르다', () => {
  const keys = new RequestKeys()
  const key = keys.for('event-1')
  assert.equal(keys.for('event-1'), key)
  assert.notEqual(keys.for('event-2'), key)
  keys.done('event-1')
  assert.notEqual(keys.for('event-1'), key)
})
test('확정 키는 저장소 및 저장소 장애 상황에도 재시도에 유지된다', () => {
  const items = new Map()
  const storage = {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, value),
  }
  assert.equal(
    confirmationKey('result-1', storage),
    confirmationKey('result-1', storage),
  )
  const unavailable = {
    getItem: () => {
      throw new Error('unavailable')
    },
    setItem: () => {},
  }
  assert.equal(
    confirmationKey('result-2', unavailable),
    confirmationKey('result-2', unavailable),
  )
})
test('복원 입력은 현재 버전 ID와 일치하는 저장 스냅샷만 사용한다', () => {
  const message = (version, budget) => ({
    metadata_json: {
      response: {
        data: {
          input_version_id: version,
          parsed_input: { input: { budget_krw: budget } },
        },
      },
    },
  })
  assert.deepEqual(
    currentInput([message(1001, 100), message(1002, 200)], 1002),
    { budget_krw: 200 },
  )
  assert.equal(currentInput([message(1001, 100)], 1002), null)
})
test('지난 질문·이미 답한 질문은 다시 답하도록 표시하지 않는다', () => {
  const message = {
    role: 'assistant',
    metadata_json: {
      response: {
        status: 'needs_input',
        data: { question_id: 'q_1', base_version_id: 1001 },
      },
    },
  }
  assert.equal(currentQuestion([message], { current_version_id: 1002 }), null)
  assert.equal(
    currentQuestion([message], { current_version_id: 1001 }).question_id,
    'q_1',
  )
  message.metadata_json.answered = true
  assert.equal(currentQuestion([message], { current_version_id: 1001 }), null)
})
test('별칭 안은 원본 경고를 확인하고 선택 불가·순환 안은 막는다', () => {
  const original = { choice_key: 'purchase_1', total_krw: 120400 }
  const alias = { choice_key: 'purchase_2', same_as: 'purchase_1' }
  assert.equal(resolveChoice(alias, [original, alias]), original)
  assert.deepEqual(
    applicableWarnings(
      alias,
      [original, alias],
      [
        {
          warning_id: 'VAT_UNKNOWN',
          requires_ack: true,
          choice_keys: ['purchase_1'],
        },
      ],
    ).map((w) => w.warning_id),
    ['VAT_UNKNOWN'],
  )
  assert.equal(resolveChoice({ ...original, available: false }, []), null)
  assert.equal(
    resolveChoice({ choice_key: 'a', same_as: 'a' }, [
      { choice_key: 'a', same_as: 'a' },
    ]),
    null,
  )
})

test('폼 초안은 같은 버전의 후속 해석 실패에도 보존하고 다른 버전에는 섞지 않는다', () => {
  const messages = [
    {
      role: 'assistant',
      metadata_json: {
        response: {
          status: 'needs_input',
          data: {
            base_version_id: 10,
            question_id: 'old',
            draft_input: { budget_krw: 160000, items: [] },
          },
        },
      },
    },
    {
      role: 'assistant',
      metadata_json: {
        response: {
          status: 'needs_input',
          data: {
            base_version_id: 10,
            question_id: 'form',
            detail_status: 'USE_FORM',
          },
        },
      },
    },
  ]
  assert.equal(
    questionDraft(messages, { current_version_id: 10 }).budget_krw,
    160000,
  )
  assert.equal(questionDraft(messages, { current_version_id: 11 }), null)
})
