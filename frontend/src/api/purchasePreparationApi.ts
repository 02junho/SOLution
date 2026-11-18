import type { Answer, Snapshot } from '../types/purchasePreparation'

export interface PreparationApi {
  get(id: string, signal?: AbortSignal): Promise<Snapshot>
  send(id: string, version: number, requestId: string, text: string): Promise<Snapshot>
  answer(id: string, version: number, requestId: string, questionId: string, value: Answer): Promise<Snapshot>
  preview(id: string, version: number): Promise<Snapshot>
}

export class PreparationApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

// 상대 URL을 사용합니다. 이 함수를 기존 api/client.ts에 연결
async function request(path: string, init?: RequestInit): Promise<Snapshot> {
  const response = await fetch(path, { credentials: 'same-origin', ...init })
  const data = await response.json().catch(() => null)
  if (!response.ok) {
    const detail = data?.message || data?.detail
    throw new PreparationApiError(response.status,
      typeof detail === 'string' ? detail : `서버 요청에 실패했습니다. (${response.status})`)
  }
  if (!data || typeof data.version !== 'number' || !Array.isArray(data.messages)) {
    throw new PreparationApiError(502, '서버 응답이 매입 준비 화면 명세와 다릅니다.')
  }
  return data
}
const root = (id: string) => `/api/v1/purchase-preparations/${encodeURIComponent(id)}`
const post = (url: string, body: object) => request(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
export const purchasePreparationApi: PreparationApi = {
  get: (id, signal) => request(root(id), { signal }),
  send: (id, version, requestId, text) => post(`${root(id)}/messages`, {
    expected_version: version, client_request_id: requestId, text,
  }),
  answer: (id, version, requestId, questionId, answer) =>
    post(`${root(id)}/questions/${encodeURIComponent(questionId)}/answers`, {
      expected_version: version, client_request_id: requestId, answer,
    }),
  preview: (id, version) => post(`${root(id)}/material-requirements/preview`, { expected_version: version }),
}
