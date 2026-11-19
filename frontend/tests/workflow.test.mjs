import { afterEach, test } from 'node:test'
import assert from 'node:assert/strict'
import { request } from '../src/api/client.ts'
import { workflowApi } from '../src/api/workflowApi.ts'
import {
  applicableWarnings,
  fieldName,
  visibleMessages,
  confirmationKey,
  invalidateConfirmationKeys,
  currentInput,
  currentQuestion,
  questionDraft,
  RequestKeys,
  resolveChoice,
  sendsOnEnter,
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
test('저장된 기존 확정 키를 읽은 뒤 저장소가 실패해도 같은 키를 유지한다', () => {
  const key = 'persisted-before-reload'
  assert.equal(
    confirmationKey('persisted-result', {
      getItem: () => key,
      setItem: () => {
        throw new Error('쓰기 불가')
      },
    }),
    key,
  )
  assert.equal(
    confirmationKey('persisted-result', {
      getItem: () => {
        throw new Error('읽기 불가')
      },
      setItem: () => {},
    }),
    key,
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


test('질문 선택지는 한국어로 표시하며 모르는 선택지는 그대로 유지한다', () => {
  assert.equal(fieldName('gross_need', 'gross_need'), '필요 총량')
  assert.equal(fieldName('usable_inventory', 'usable_inventory'), '현재 사용 가능한 재고')
  assert.equal(fieldName('safety_stock', 'safety_stock'), '남겨 둘 안전재고')
  assert.equal(fieldName('storage_capacity', 'storage_capacity'), '보관 한도')
  assert.equal(fieldName('max_end_inventory', 'max_end_inventory'), '기간 끝 재고 한도')
  assert.equal(fieldName('네, 같이 일해요', '네, 같이 일해요'), '네, 같이 일해요')
})

test('삭제된 메시지 표시를 숨겨도 진행 중 질문은 유지한다', () => {
  const messages = [{ message_id: 1, role: 'assistant', metadata_json: {
    deleted: true, response: { status: 'needs_input', data: { question_id: 'q1', base_version_id: 10 } },
  } }]
  assert.deepEqual(visibleMessages(messages), [])
  assert.equal(currentQuestion(messages, { current_version_id: 10 }).question_id, 'q1')
})

test('업무 삭제 API는 올바른 경로로 요청하고 실패를 전달한다', async () => {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push([url, init.method])
    return json({ status: 'ok', data: {} })
  }
  await workflowApi.deleteSession(500)
  assert.deepEqual(calls, [
    ['/api/v1/work-sessions/500', 'DELETE'],
  ])
  globalThis.fetch = async () => json({ status: 'error', data: { detail_code: 'SESSION_NOT_FOUND' }, message: '업무를 찾을 수 없습니다.' }, 404)
  await assert.rejects(() => workflowApi.deleteSession(600), { code: 'SESSION_NOT_FOUND' })
})

test('대화창은 Enter로 보내고 Shift+Enter·한글 조합 중 Enter는 보내지 않는다', () => {
  const key = (over) => ({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13, ...over })
  assert.equal(sendsOnEnter(key({})), true)
  assert.equal(sendsOnEnter(key({ shiftKey: true })), false)
  assert.equal(sendsOnEnter(key({ isComposing: true })), false)
  assert.equal(sendsOnEnter(key({ keyCode: 229 })), false)
  assert.equal(sendsOnEnter(key({ key: 'a', keyCode: 65 })), false)
})


test('삭제 뒤 같은 계획 서명의 저장 키는 교체되고 새 키의 재시도는 유지된다', () => {
  const values = new Map()
  const storage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) }
  const signature = JSON.stringify([2002, 1002, 'purchase_1', []])
  const before = confirmationKey(signature, storage)
  invalidateConfirmationKeys(2002, storage)
  const after = confirmationKey(signature, storage)
  assert.notEqual(after, before)
  assert.equal(confirmationKey(signature, storage), after)
  const unrelated = JSON.stringify([2003, 1002, 'purchase_1', []])
  const other = confirmationKey(unrelated, storage)
  invalidateConfirmationKeys(2002, storage)
  assert.equal(confirmationKey(unrelated, storage), other)
})


test('복원한 확정 세대는 저장소 장애에도 유지하고 명시적 삭제 후에만 교체한다', () => {
  const resultId = 990002
  const signature = JSON.stringify([resultId, 1002, 'purchase_1', []])
  const generation = 'restored-generation'
  const savedKey = 'restored-request-key'
  const values = new Map([
    [`solution:confirm-generation:${resultId}`, generation],
    [`solution:confirm:${signature}:${generation}`, savedKey],
  ])
  let unavailable = false
  const storage = {
    getItem(name) {
      if (unavailable) throw new Error('storage unavailable')
      return values.get(name) ?? null
    },
    setItem(name, value) {
      if (unavailable) throw new Error('storage unavailable')
      values.set(name, value)
    },
  }
  assert.equal(confirmationKey(signature, storage), savedKey)
  unavailable = true
  assert.equal(confirmationKey(signature, storage), savedKey)
  assert.equal(confirmationKey(signature, undefined), savedKey)
  invalidateConfirmationKeys(resultId, storage)
  const next = confirmationKey(signature, storage)
  assert.notEqual(next, savedKey)
  assert.equal(confirmationKey(signature, storage), next)
})
