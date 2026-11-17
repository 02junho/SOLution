import { request } from './client'
import type { OperationPlan } from '../types/api'
import type { OperationResult, OperationTrace } from '../features/operation/types'

// /api 접두사는 공통 client가 붙인다. 브라우저에서 FastAPI 주소를 호출하지 않는다.
export function loadOperationResult(resultId: number, view: 'summary' | 'detail' = 'summary', signal?: AbortSignal) {
  return request<OperationResult>(`/v1/operation/results/${resultId}?view=${view}`, { signal })
}

export function loadOperationTrace(resultId: number, logId: number, signal?: AbortSignal) {
  return request<OperationTrace>(`/v1/operation/results/${resultId}/traces/${logId}`, { signal })
}

// 같은 실행을 다시 보낼 때는 같은 Idempotency-Key를 쓴다(필수). 내부 X-Request-Key는 Spring이 만든다 (API v0.4).
export function runOperation(sessionId: number, inputVersionId: number, requestKey: string) {
  return request<OperationResult>(`/v1/operation/sessions/${sessionId}/results`, {
    method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify({ input_version_id: inputVersionId }),
  })
}

// 엄혜원 담당 공통 확정 API에 연결하는 클라이언트. 확정 저장을 운영 API로 중복 구현하지 않는다.
export function confirmOperation(result: OperationResult, choice: OperationPlan, warningIds: string[], requestKey: string) {
  return request<{ confirmation_id: number; is_current_version: boolean }>(`/v1/work-results/${result.result_id}/confirm`, {
    method: 'POST', headers: { 'Idempotency-Key': requestKey },
    body: JSON.stringify({ expected_input_version_id: result.input_version_id, selected_choice_key: choice,
      acknowledged_warning_ids: warningIds }),
  })
}
