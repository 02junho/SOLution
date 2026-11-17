import { request } from './client.ts'
import type { ClientResponse } from './client.ts'
import type { FeatureType } from '../types/api'
import type {
  Page,
  SessionSummary,
  SessionContext,
  Message,
  EventData,
  JsonObject,
  PurchaseResult,
  Confirmation,
  ConfirmationDetail,
  Confirmed,
} from '../types/workflow'

export class WorkflowError extends Error {
  code: string
  httpStatus?: number
  constructor(message: string, code = 'REQUEST_FAILED', httpStatus?: number) {
    super(message)
    this.code = code
    this.httpStatus = httpStatus
  }
}
function unwrap<T>(response: ClientResponse<T>): T {
  if (response.status === 'error' || response.data === null) {
    const data = response.data as JsonObject | null
    throw new WorkflowError(
      response.message || '요청을 완료하지 못했어요. 다시 시도해 주세요.',
      typeof data?.detail_code === 'string' ? data.detail_code : undefined,
      response.httpStatus,
    )
  }
  return response.data
}
function query(values: Record<string, string | number | null | undefined>) {
  const search = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value != null && value !== '') search.set(key, String(value))
  })
  return search.size ? `?${search}` : ''
}
const read = async <T>(path: string) => unwrap(await request<T>(path))
const write = async <T>(
  path: string,
  body: unknown,
  header?: [string, string],
) =>
  unwrap(
    await request<T>(path, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: header ? { [header[0]]: header[1] } : undefined,
    }),
  )
export const workflowApi = {
  sessions: (feature?: FeatureType, cursor?: string | null) =>
    read<Page<SessionSummary>>(
      `/v1/work-sessions${query({ feature_type: feature, cursor, size: 20 })}`,
    ),
  context: (id: number) => read<SessionContext>(`/v1/work-sessions/${id}`),
  create: (
    store: number,
    feature: FeatureType,
    method: 'agent' | 'form',
    title: string,
  ) =>
    write<{ session_id: number }>('/v1/work-sessions', {
      store_id: store,
      feature_type: feature,
      input_method: method,
      title,
    }),
  messages: (id: number, cursor?: string | null) =>
    read<Page<Message>>(
      `/v1/work-sessions/${id}/messages${query({ cursor, size: 100 })}`,
    ),
  async allMessages(id: number) {
    const items: Message[] = []
    let cursor: string | null = null
    for (let page = 0; page < 100; page++) {
      const response = await this.messages(id, cursor)
      items.push(...response.items)
      cursor = response.next_cursor
      if (!cursor) return items
    }
    throw new WorkflowError(
      '대화가 많아 한 번에 불러오지 못했어요. 다른 업무를 선택해 주세요.',
    )
  },
  async event(id: number, body: JsonObject, key: string) {
    const response = await request<EventData>(
      `/v1/work-sessions/${id}/events`,
      {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'X-Request-Key': key },
      },
    )
    unwrap(response)
    return response
  },
  confirmInput: (version: number, number: number) =>
    write(`/v1/work-versions/${version}/confirm-input`, {
      expected_version_no: number,
    }),
  async calculate(id: number, version: number, key: string) {
    const response = await request<JsonObject>(
      `/v1/purchase/sessions/${id}/results`,
      {
        method: 'POST',
        body: JSON.stringify({ input_version_id: version }),
        headers: { 'X-Request-Key': key },
      },
    )
    unwrap(response)
    return response
  },
  result: (id: number) => read<PurchaseResult>(`/v1/purchase/results/${id}`),
  confirm: (
    result: number,
    version: number,
    choice: string,
    warnings: string[],
    key: string,
  ) =>
    write<Confirmed>(
      `/v1/work-results/${result}/confirm`,
      {
        expected_input_version_id: version,
        selected_choice_key: choice,
        acknowledged_warning_ids: [...warnings].sort(),
      },
      ['Idempotency-Key', key],
    ),
  confirmations: (
    feature?: FeatureType,
    cursor?: string | null,
    session?: number,
  ) =>
    read<Page<Confirmation>>(
      `/v1/work-confirmations${query({ feature_type: feature, session_id: session, cursor, size: 20 })}`,
    ),
  confirmation: (id: number) =>
    read<ConfirmationDetail>(`/v1/work-confirmations/${id}`),
}
