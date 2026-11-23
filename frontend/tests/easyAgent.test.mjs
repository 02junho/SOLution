import assert from 'node:assert/strict'
import test from 'node:test'
import { answerOnly, changeSentence, chatBubbles, openQuestion, outcome, questionChoices, questionText } from '../src/features/easy/agent.ts'

test('조건이 바뀐 응답은 새 입력 버전으로, 같은 버전이면 그대로로 본다', () => {
  const changed = outcome({ status: 'ok', data: { input_version_id: 12, version_no: 3 }, message: '입력을 저장했어요.' }, 11)
  assert.deepEqual(changed, { kind: 'changed', versionId: 12, versionNo: 3, message: '입력을 저장했어요.', run: false })
  const same = outcome({ status: 'ok', data: { detail_status: 'NO_CHANGE', input_version_id: 11, version_no: 2 }, message: '장보기 계획을 세워 볼게요.' }, 11)
  assert.equal(same.kind, 'same')
  assert.equal(same.message, '장보기 계획을 세워 볼게요.')
})

test('운영 계산 시작 표시(run_operation)를 놓치지 않는다', () => {
  assert.equal(outcome({ status: 'ok', data: { action: 'run_operation', input_version_id: 5, version_no: 1 } }, 5).run, true)
  assert.equal(outcome({ status: 'ok', data: { action: 'run_operation', input_version_id: 6, version_no: 2 } }, 5).run, true)
})

test('질문·폼으로 넘기기·처리 불가를 나눈다', () => {
  const asked = outcome({ status: 'needs_input', data: { question_id: 'q_1', question: { text: '예산을 얼마로 할까요?', choices: ['15만 원', '20만 원'] } } }, 1)
  assert.equal(asked.kind, 'question')
  assert.equal(asked.message, '예산을 얼마로 할까요?')
  assert.deepEqual(questionChoices(asked.question), ['15만 원', '20만 원'])
  assert.equal(outcome({ status: 'needs_input', data: { detail_status: 'USE_FORM' }, message: '폼으로 입력해 주시겠어요?' }, 1).kind, 'use-form')
  const refused = outcome({ status: 'infeasible', data: { detail_status: 'UNSUPPORTED', suggestions: ['현재 인원 또는 1명 추가 후보를 선택해 주세요.'] }, message: '지원하는 운영 후보 범위 밖이에요.' }, 1)
  assert.deepEqual(refused, { kind: 'refused', message: '지원하는 운영 후보 범위 밖이에요.', suggestions: ['현재 인원 또는 1명 추가 후보를 선택해 주세요.'] })
})

test('질문 문장이 없으면 빠진 칸 이름으로 묻는다', () => {
  assert.equal(questionText({ missing_fields: [{ path: 'budget_krw', label: '예산' }] }), '이 값을 알려 주세요: 예산')
  assert.equal(questionText({ missing_fields: [{ path: 'planning_days', label: 'planning_days' }, { path: 'max_delivery_count', label: 'max_delivery_count' }] }),
    '이 값을 알려 주세요: 계획 기간(며칠), 배송 받는 횟수', '칸 이름은 사장님 말로')
  assert.equal(questionText(null), '')
})

test('저장된 대화에서 폼 저장 기록은 빼고, 질문 답은 따옴표를 벗긴다', () => {
  const messages = [
    { message_id: 1, role: 'user', content: '(폼 입력)', version_no: 1, metadata_json: null, created_at: '' },
    { message_id: 2, role: 'assistant', content: '입력을 저장했어요.', version_no: 1, metadata_json: { source: 'form' }, created_at: '' },
    { message_id: 3, role: 'user', content: '예산 줄여 줘', version_no: 1, metadata_json: null, created_at: '' },
    { message_id: 4, role: 'assistant', content: '빠진 입력을 알려 주세요.', version_no: 1, metadata_json: { source: 'message', response: { status: 'needs_input', data: { question_id: 'q_9', base_version_id: 10, question: { text: '얼마로 줄일까요?' } } } }, created_at: '' },
    { message_id: 5, role: 'user', content: '"15만 원"', version_no: 1, metadata_json: null, created_at: '' },
  ]
  assert.deepEqual(chatBubbles(messages), [
    { role: 'owner', text: '예산 줄여 줘' },
    { role: 'agent', text: '얼마로 줄일까요?' },
    { role: 'owner', text: '15만 원' },
  ])
})

test('지금 입력 버전에서 아직 답하지 않은 질문만 다시 연다', () => {
  const ask = (meta) => [{ message_id: 1, role: 'assistant', content: '', version_no: 1, created_at: '', metadata_json: meta }]
  const response = { status: 'needs_input', data: { question_id: 'q_1', base_version_id: 7 } }
  assert.equal(openQuestion(ask({ response }), 7).question_id, 'q_1')
  assert.equal(openQuestion(ask({ response }), 8), null, '조건이 바뀌면 지난 질문')
  assert.equal(openQuestion(ask({ response, answered: true }), 7), null, '이미 답한 질문')
  assert.equal(openQuestion(ask({ response: { status: 'needs_input', data: { question_id: 'q_2', base_version_id: 7, detail_status: 'USE_FORM' } } }), 7), null, '폼으로 넘기기는 질문 카드가 아님')
})

test('바뀐 조건만 한 문장으로 알려 준다', () => {
  assert.equal(changeSentence({ '예산': '200,000원', '배송 횟수': '2번까지' }, { '예산': '150,000원', '배송 횟수': '2번까지' }), '조건을 바꿨어요. 예산 200,000원 → 150,000원')
  assert.equal(changeSentence({ '예산': '200,000원' }, { '예산': '200,000원' }), '')
})

test('폼으로 만든 업무의 빠진 값 질문은 말풍선으로 보여 준다', () => {
  const messages = [
    { role: 'user', content: '(폼 입력)', metadata_json: null },
    { role: 'assistant', content: '모르는 값은 확인이 필요해요. 빠진 입력을 알려 주세요.', metadata_json: { source: 'form', question: {
      question_id: 'q1', missing_fields: [{ path: 'planning_days', label: 'planning_days' }, { path: 'budget_krw', label: 'budget_krw' }] } } },
    { role: 'assistant', content: '입력을 저장했어요.', metadata_json: { source: 'form' } },
  ]
  const bubbles = chatBubbles(messages)
  assert.equal(bubbles.length, 1)
  assert.match(bubbles[0].text, /^이 값을 알려 주세요: /)
  assert.match(bubbles[0].text, /예산/)
})

test('조건을 묻지 않고 대답만 한 응답은 질문 카드 없이 말로만 보여 준다', () => {
  const answer = { question_id: 'q1', detail_status: 'NEEDS_INPUT', missing_fields: [{ path: 'content', label: '안내' }],
    question: { text: '원두는 계산 결과에서 거래처별로 확인해 주세요. 실제 발주는 도와드릴 수 없어요.', choices: [], question_key: 'content' } }
  assert.equal(answerOnly(answer), true)
  const out = outcome({ status: 'needs_input', data: answer }, 10)
  assert.equal(out.kind, 'same')
  assert.match(out.message, /실제 발주/)
  // 물음표로 묻거나 고를 것이 있으면 질문 그대로
  assert.equal(answerOnly({ ...answer, question: { ...answer.question, text: '어느 품목 말씀이세요?' } }), false)
  assert.equal(answerOnly({ ...answer, question: { ...answer.question, choices: ['원두', '우유'] } }), false)
  assert.equal(answerOnly({ ...answer, missing_fields: [{ path: 'budget_krw', label: 'budget_krw' }] }), false)
})
