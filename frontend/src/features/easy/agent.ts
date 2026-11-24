// 쉬운 화면의 AI 대화: 서버 응답을 화면이 할 일로 바꾸는 순수 함수들.
// 말·질문 답은 Spring(/work-sessions/{id}/events)을 거쳐 AI 해석(/agent/interpret)으로 간다.
import type { EventData, JsonObject, Message } from '../../types/workflow'

export type ChatBubble = { role: 'owner' | 'agent'; text: string }

/** 이벤트 응답을 보고 화면이 할 일 */
export type Outcome =
  | { kind: 'changed'; versionId: number; versionNo: number; message: string; run: boolean }
  | { kind: 'same'; message: string; run: boolean }
  | { kind: 'question'; question: EventData; message: string }
  | { kind: 'use-form'; message: string }
  | { kind: 'refused'; message: string; suggestions: string[] }

const FIELD: Record<string, string> = {
  planning_days: '계획 기간(며칠)', budget_krw: '예산', max_delivery_count: '배송 받는 횟수',
  usable_inventory: '지금 있는 재고', gross_need: '필요한 양', safety_stock: '남겨 둘 양', storage_capacity: '보관할 수 있는 양',
  max_end_inventory: '기간 끝에 남겨도 되는 양', minimum_order_krw: '거래처 최소 주문 금액', delivery_fee_krw: '거래처 배송비',
  daily_orders: '하루 주문 수', is_owner_working: '사장님 근무 여부', hourly_wage_krw: '직원 시급', last_order_time: '라스트 오더',
  form_input: '조건',
}
const obj = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const strings = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [])

export function outcome(
  response: { status: string; data: unknown; message?: string | null },
  previousVersionId: number | null,
): Outcome {
  const data = obj(response.data) as EventData
  const message = (response.message ?? '').trim()
  const run = data.action === 'run_operation'
  if (response.status === 'needs_input') {
    if (data.detail_status === 'USE_FORM') return { kind: 'use-form', message: message || '말로는 알아듣기 어려웠어요. 아래 "고치기"로 바꿔 주세요.' }
    // 조건을 묻는 게 아니라 대답만 한 경우(예: "원두 어디서 사?"에 대한 안내)는 질문 카드 없이 말풍선으로만 보여 준다.
    if (answerOnly(data)) return { kind: 'same', message: questionText(data) || message || '조건은 그대로예요.', run: false }
    return { kind: 'question', question: data, message: questionText(data) || message }
  }
  if (response.status === 'infeasible') {
    return { kind: 'refused', message: message || '이번 서비스에서는 처리할 수 없는 요청이에요.', suggestions: strings(data.suggestions) }
  }
  const versionId = num(data.input_version_id)
  const versionNo = num(data.version_no)
  if (versionId !== null && versionNo !== null && versionId !== previousVersionId) {
    return { kind: 'changed', versionId, versionNo, message, run }
  }
  // silent: 업무 시작만 하는 말("장보기 계획 세워 줘")이라 화면의 시작 안내 말고는 더 할 말이 없다.
  if (data.silent === true) return { kind: 'same', message: '', run }
  return { kind: 'same', message: message || '조건은 그대로예요.', run }
}

export function questionText(question: EventData | null): string {
  if (!question) return ''
  const text = question.question?.text
  if (typeof text === 'string' && text.trim()) return text.trim()
  // 서버가 칸 이름(budget_krw 등)을 그대로 줄 때가 있어 사장님 말로 바꾼다.
  const labels = [...new Set((question.missing_fields ?? []).map((field) => FIELD[field.path.split('.').at(-1) ?? ''] ?? FIELD[field.label] ?? field.label).filter(Boolean))]
  return labels.length ? `이 값을 알려 주세요: ${labels.join(', ')}` : ''
}

export function questionChoices(question: EventData | null): string[] {
  return strings(question?.question?.choices)
}

/** AI가 조건 칸이 아니라 자유 대답("content")만 남기고, 고를 것도 묻는 말(?)도 없으면 질문이 아니라 대답이다. */
export function answerOnly(question: EventData | null): boolean {
  if (!question) return false
  const fields = question.missing_fields ?? []
  const text = questionText(question)
  return fields.length > 0 && fields.every((field) => field.path === 'content')
    && questionChoices(question).length === 0 && !/[?？]/.test(text)
}

/** 아직 답하지 않은 서버 질문(지금 입력 버전 기준). 화면을 새로 열어도 이어서 답할 수 있게. */
export function openQuestion(messages: Message[], currentVersionId: number | null): EventData | null {
  const last = [...messages].reverse().find((m) => m.role === 'assistant' && m.metadata_json?.response)
  if (!last || last.metadata_json?.answered) return null
  const response = obj(last.metadata_json?.response)
  const data = obj(response.data) as EventData
  return response.status === 'needs_input'
    && data.detail_status !== 'USE_FORM'
    && !answerOnly(data)
    && typeof data.question_id === 'string'
    && (data.base_version_id ?? null) === currentVersionId
    ? data
    : null
}

/** 저장된 대화를 말풍선으로. 폼 저장 기록("(폼 입력)")과 지운 기록은 뺀다. */
export function chatBubbles(messages: Message[]): ChatBubble[] {
  const bubbles: ChatBubble[] = []
  for (const message of messages) {
    if (message.metadata_json?.deleted) continue
    if (message.role === 'user') {
      const text = message.content?.trim()
      if (!text || text === '(폼 입력)') continue
      bubbles.push({ role: 'owner', text: answerText(text) })
    } else if (message.role === 'assistant') {
      if (message.metadata_json?.source === 'form') {
        // 폼으로 저장한 안내는 숨긴다. 다만 견적으로 만든 업무처럼 빠진 값을 묻는 질문은 보여 준다.
        const asked = questionText(obj(message.metadata_json?.question) as EventData)
        if (asked) bubbles.push({ role: 'agent', text: asked })
        continue
      }
      const response = obj(message.metadata_json?.response)
      const text = response.status === 'needs_input' ? questionText(obj(response.data) as EventData) || message.content
        // 서버의 저장 안내는 쉬운 말로 바꿔 보여 준다.
        : message.content === '입력을 저장했어요. 입력을 확인해 주세요.' ? '조건을 바꿨어요.' : message.content
      if (text?.trim()) bubbles.push({ role: 'agent', text: text.trim() })
    }
  }
  return bubbles
}

// 질문 답은 JSON 문자열로 저장된다("\"2번\""). 따옴표만 벗겨 보여 준다.
function answerText(text: string) {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'string' ? parsed : text
  } catch {
    return text
  }
}

/** 확인 카드 값이 무엇에서 무엇으로 바뀌었는지 한 문장으로. 서버 문구("입력을 저장했어요")보다 사장님이 알아보기 쉽게. */
export function changeSentence(before: Record<string, string>, after: Record<string, string>): string {
  const parts = Object.keys(after)
    .filter((label) => before[label] !== undefined && before[label] !== after[label])
    .map((label) => `${label} ${before[label]} → ${after[label]}`)
  return parts.length ? `조건을 바꿨어요. ${parts.join(' · ')}` : ''
}
