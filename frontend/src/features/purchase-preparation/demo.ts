import { PreparationApiError } from '../../api/purchasePreparationApi'
import type { PreparationApi } from '../../api/purchasePreparationApi'
import type { Snapshot } from '../../types/purchasePreparation'

import fixture from './demoSnapshot.json'
const initial = fixture as Snapshot

let state = structuredClone(initial)
const wait = () => new Promise(resolve => setTimeout(resolve, 300))
const confirmed = new Set<string>()
async function change(version: number, edit: () => void, requestId?: string) {
  await wait()
  if (requestId && confirmed.has(requestId)) return structuredClone(state)
  if (version !== state.version) throw new PreparationApiError(409, '이전 버전입니다.')
  edit()
  state.version++
  if (requestId) confirmed.add(requestId)
  return structuredClone(state)
}
export const demoApi: PreparationApi = {
  get: async () => { await wait(); return structuredClone(state) },
  send: (_, version, key, text) => change(version, () => {
    state.messages.push({ message_id: key, role: 'USER', text }, {
      message_id: crypto.randomUUID(), role: 'ASSISTANT',
      text: '데모에서 입력을 받았어요. 실제 견적 분석과 판매량 추출은 Spring 연동 모드에서 실행됩니다.',
    })
  }, key),
  answer: (_, version, key, questionId, answer) => change(version, () => {
    const q = state.questions.find(item => item.question_id === questionId && item.state === 'OPEN')
    if (!q || answer.type !== 'OPTION' || !q.options?.some(o => o.value === answer.value)) {
      throw new PreparationApiError(422, '데모에서는 제공된 답변 버튼을 선택해 주세요.')
    }
    const line = state.quotes.items.find(row => row.line_id === q.target_id)
    if (line && (answer.value === 'INCLUDED' || answer.value === 'EXCLUDED' || answer.value === 'UNKNOWN')) {
      line.vat_status = answer.value
      if (answer.value !== 'UNKNOWN') {
        state.issues = state.issues.filter(issue => issue.target_id !== q.target_id || issue.field !== q.field)
      }
    }
    q.state = 'ANSWERED'
    state.messages.push({ message_id: key, role: 'USER',
      text: q.options.find(o => o.value === answer.value)!.label }, {
      message_id: crypto.randomUUID(), role: 'ASSISTANT',
      text: '답변을 기록했어요. 다른 확인 항목은 그대로 남아 있어요.',
    })
  }, key),
  preview: async () => { await wait(); return structuredClone(state) },
}
