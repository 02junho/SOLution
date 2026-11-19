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
export const amount = (
  value: unknown,
  suffix = '원',
  options?: Intl.NumberFormatOptions,
) =>
  typeof value === 'number' && Number.isFinite(value)
    ? `${value.toLocaleString('ko-KR', options)}${suffix}`
    : '확인 필요'
export const dateTime = (value: string) =>
  new Date(value).toLocaleString('ko-KR', {
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
// 대화창 키 입력: Enter는 보내고 Shift+Enter는 줄바꿈한다.
// 한글 조합 중 Enter는 글자 확정이라 보내지 않는다. Safari는 확정 Enter를
// isComposing=false, keyCode=229로 보내므로 229도 함께 거른다.
export const sendsOnEnter = (key: {
  key: string
  shiftKey: boolean
  isComposing: boolean
  keyCode: number
}) =>
  key.key === 'Enter' &&
  !key.shiftKey &&
  !key.isComposing &&
  key.keyCode !== 229
export const featureName = (feature: string) =>
  feature === 'purchase' ? '매입·재고' : '운영 실험'
// 이전 버전에서 삭제 표시한 기록은 원문 복구 없이 계속 숨긴다.
export function visibleMessages(messages: Message[]) {
  return messages.filter((message) =>
    (message.role === 'user' || message.role === 'assistant') && !message.metadata_json?.deleted,
  )
}
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
    usable_inventory: '현재 사용 가능한 재고',
    gross_need: '필요 총량',
    safety_stock: '남겨 둘 안전재고',
    storage_capacity: '보관 한도',
    max_end_inventory: '기간 끝 재고 한도',
    form_input: '폼 입력',
  }
  return names[path.split('.').at(-1) ?? path] ?? label
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
const confirmationGenerations = new Map<number, string>()
export function invalidateConfirmationKeys(resultId: number, storage?: Pick<Storage, 'getItem' | 'setItem'>) {
  const generation = crypto.randomUUID()
  confirmationGenerations.set(resultId, generation)
  try { storage?.setItem(`solution:confirm-generation:${resultId}`, generation) } catch { /* Memory fallback. */ }
}
export function confirmationKey(
  signature: string,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
): string {
  try {
    const [resultId] = JSON.parse(signature)
    let generation = confirmationGenerations.get(resultId)
    try { generation ??= storage?.getItem(`solution:confirm-generation:${resultId}`) ?? undefined } catch { /* Memory fallback. */ }
    if (generation) {
      confirmationGenerations.set(resultId, generation)
      signature = `${signature}:${generation}`
    }
  } catch { /* Non-JSON signatures and unavailable storage retain memory retries. */ }
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
