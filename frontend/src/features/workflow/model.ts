import type {
  Choice,
  EventData,
  JsonObject,
  Message,
  SessionContext,
  Warning,
} from '../../types/workflow'

export const object = (value: unknown): JsonObject =>
  value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {}
export const amount = (value: unknown, suffix = '원') =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('ko-KR')}${suffix}`
    : '확인 필요'
export const dateTime = (value: string) =>
  new Date(value).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
export const featureName = (feature: string) =>
  feature === 'purchase' ? '매입·재고' : '운영 실험'
export function currentInput(
  messages: Message[],
  version: number | null,
): JsonObject | null {
  if (version === null) return null
  for (const message of [...messages].reverse()) {
    const data = object(object(message.metadata_json?.response).data)
    if (data.input_version_id === version) {
      const input = object(object(data.parsed_input).input)
      if (Object.keys(input).length) return input
    }
  }
  return null
}
export function currentQuestion(
  messages: Message[],
  context: SessionContext | null,
): EventData | null {
  if (!context) return null
  const last = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === 'assistant' && message.metadata_json?.response,
    )
  const response = object(last?.metadata_json?.response)
  const data = object(response.data) as EventData
  return response.status === 'needs_input' &&
    !last?.metadata_json?.answered &&
    typeof data.question_id === 'string' &&
    (data.base_version_id ?? null) === context.current_version_id
    ? data
    : null
}
// 해석 실패로 새 질문이 발급돼도 같은 입력 버전의 미완성 폼을 잃지 않는다.
export function questionDraft(
  messages: Message[],
  context: SessionContext | null,
): JsonObject | null {
  if (!currentQuestion(messages, context)) return null
  for (const message of [...messages].reverse()) {
    const response = object(message.metadata_json?.response)
    const data = object(response.data)
    if (
      response.status === 'needs_input' &&
      (data.base_version_id ?? null) === context?.current_version_id
    ) {
      const draft = object(data.draft_input)
      if (Object.keys(draft).length) return draft
    }
  }
  return null
}
export function fieldName(path: string, label: string) {
  const names: Record<string, string> = {
    budget_krw: '예산',
    planning_days: '계획 기간',
    max_delivery_count: '배송 횟수 상한',
    usable_inventory: '사용 가능한 재고',
    gross_need: '필요 총량',
    safety_stock: '안전재고',
    storage_capacity: '보관 한도',
    max_end_inventory: '기간 끝 재고 한도',
    form_input: '폼 입력',
  }
  return names[path.split('.').at(-1) ?? path] ?? label
}
// 업무 이름을 비워 두면 날짜를 넣어 하던 업무 목록에서 서로 구분되게 한다. 예: "11월 18일 매입 준비"
export function defaultTitle(feature: string, now = new Date()) {
  const day = now.toLocaleDateString('ko-KR', {
    month: 'long',
    day: 'numeric',
  })
  return `${day} ${feature === 'operation' ? '운영' : '매입'} 준비`
}
// 양을 읽기 쉬운 단위로: 2700g → 2.7kg, 12000ml → 12L, 50ea → 50개. 계산 값은 그대로 두고 보여 주는 말만 바꾼다.
export function quantity(value: unknown, unit: string) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '확인 필요'
  const text = (n: number) =>
    n.toLocaleString('ko-KR', { maximumFractionDigits: 2 })
  if (unit === 'g' && Math.abs(value) >= 1000) return `${text(value / 1000)}kg`
  if (unit === 'ml' && Math.abs(value) >= 1000)
    return `${text(value / 1000)}L`
  if (unit === 'ea') return `${text(value)}개`
  return `${text(value)}${unit}`
}
// 견적 한 묶음: 1000g → 1kg, 50ea → 50개 묶음
export const packLabel = (size: unknown, unit: string) =>
  `${quantity(size, unit)}${unit === 'ea' ? ' 묶음' : ''}`
// 안마다 한 문장 설명. 숫자만 보고도 무엇이 다른지 바로 알 수 있게 한다.
export function choiceSentence(value: Choice, cheapest: number | null) {
  const parts: string[] = []
  if (typeof value.total_krw === 'number' && cheapest !== null)
    parts.push(
      value.total_krw <= cheapest
        ? '가장 싸요.'
        : `가장 싼 안보다 ${amount(value.total_krw - cheapest)} 더 들어요.`,
    )
  if (typeof value.delivery_count === 'number')
    parts.push(
      value.delivery_count === 1
        ? '한 번에 다 받아요.'
        : `배송은 ${value.delivery_count}번 와요.`,
    )
  return parts.join(' ')
}
// 비교용 기준선(품목마다 단위가격이 가장 싼 곳에서 따로 사기)과의 차이를 쉬운 말로 바꾼다.
export function baselineSentence(diff: number) {
  if (diff === 0) return '품목마다 가장 싼 곳에서 따로 살 때와 같아요.'
  return `품목마다 가장 싼 곳에서 따로 살 때보다 ${amount(Math.abs(diff))} ${diff < 0 ? '아껴요' : '더 들어요'}.`
}
export function resolveChoice(
  choice: Choice,
  choices: Choice[],
): Choice | null {
  let resolved = choice
  const visited = new Set<string>()
  for (;;) {
    if (
      visited.has(resolved.choice_key) ||
      resolved.available === false ||
      resolved.confirmable === false
    )
      return null
    visited.add(resolved.choice_key)
    if (!resolved.same_as) return resolved
    const next = choices.find((item) => item.choice_key === resolved.same_as)
    if (!next) return null
    resolved = next
  }
}
export function applicableWarnings(
  choice: Choice | undefined,
  choices: Choice[],
  warnings: Warning[],
) {
  if (!choice) return []
  const resolved = resolveChoice(choice, choices)
  return warnings.filter(
    (warning) =>
      !warning.choice_keys ||
      warning.choice_keys.includes(choice.choice_key) ||
      (!!resolved && warning.choice_keys.includes(resolved.choice_key)),
  )
}
// 동일 작업의 네트워크 재시도는 같은 키를 쓴다. 대화 원문은 영구 저장하지 않는다.
export class RequestKeys {
  private keys = new Map<string, string>()
  for(signature: string) {
    const key = this.keys.get(signature) ?? crypto.randomUUID()
    this.keys.set(signature, key)
    return key
  }
  done(signature: string) {
    this.keys.delete(signature)
  }
  remember(signature: string, key: string) {
    this.keys.set(signature, key)
  }
}
const confirmationKeys = new RequestKeys()
export function confirmationKey(
  signature: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): string {
  const name = `solution:confirm:${signature}`
  const fallback = confirmationKeys.for(signature)
  try {
    const previous = storage?.getItem(name)
    if (previous) {
      confirmationKeys.remember(signature, previous)
      return previous
    }
    storage?.setItem(name, fallback)
  } catch {
    /* 저장소를 사용할 수 없어도 현재 창에서는 같은 키를 유지한다. */
  }
  return fallback
}
