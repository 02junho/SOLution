import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const server = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom' })
const { default: Workspace } = await server.ssrLoadModule('/src/features/workflow/Workspace.tsx')
test.after(async () => { await server.close() })

const text = '우유 2L를 어느 칸 값으로 바꿀까요?'
const question = { question_id: 'q1', base_version_id: 10,
  question: { text, choices: ['gross_need', 'usable_inventory', 'safety_stock', 'storage_capacity', 'max_end_inventory'] },
  missing_fields: [{ path: 'content', label: text }],
}
const workspace = {
  context: { feature_type: 'purchase', session_id: 1, current_version: 1, current_version_id: 10, updated_at: '2026-11-19T00:00:00Z' },
  input: null, busy: '', messages: [{ message_id: 1, role: 'assistant', content: text, created_at: '2026-11-19T00:00:00Z',
    metadata_json: { question_id: 'q1', response: { status: 'needs_input', data: question } } }],
}
const render = (value) => renderToStaticMarkup(createElement(Workspace, {
  workspace: value, feature: 'purchase', onFeature() {}, onNew() {}, onHistory() {}, onSaved() {},
}))

test('현재 질문은 한 번 표시하고 내부 선택지 키를 한국어로 렌더링한다', () => {
  const html = render(workspace)
  assert.equal(html.split(text).length - 1, 1)
  for (const label of ['필요 총량', '현재 사용 가능한 재고', '남겨 둘 안전재고', '보관 한도', '기간 끝 재고 한도']) assert.ok(html.includes(label))
  for (const key of question.question.choices) assert.ok(!html.includes(key))
})

test('삭제 표시된 대화는 숨기고 현재 질문 카드는 유지한다', () => {
  const value = structuredClone(workspace)
  value.messages[0].content = '삭제된 대화입니다.'
  value.messages[0].metadata_json.deleted = true
  const html = render(value)
  assert.ok(!html.includes('삭제된 대화입니다.'))
  assert.ok(html.includes(text))
})
