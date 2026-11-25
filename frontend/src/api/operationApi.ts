import { request } from './client'
import type { OperationPlan } from '../types/api'
import type { OperationResult, OperationTrace } from '../features/operation/types'
import type { MenuTypes, RosterChatReply, RosterJob, StoredRosterResult } from '../features/operation/roster/rosterTypes'
import type { JsonObject } from '../types/workflow'

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

// 가게 파일 메뉴 중 낱말로 모른 이름만 보내 제조 유형을 고른다(이름과 유형 목록만 보냄). 키가 없으면 모두 null.
export function classifyMenuTypes(body: { names: string[]; types: { id: string; label: string }[] }) {
  return request<MenuTypes>('/v1/operation/menu-types', { method: 'POST', body: JSON.stringify(body) })
}

// 추천 근무표 3안 계산 시작(확인한 입력 버전에 붙음). 서버가 뒤에서 계산해 업무 결과로 저장한다. 바로 state=RUNNING.
// 미리 계산(저장 없음): 바로 STARTED / SKIPPED를 돌려준다. 결과는 서버의 요일 기억에만 남는다.
export function warmRoster(body: JsonObject) {
  return request<{ state: 'STARTED' | 'SKIPPED'; reason?: string }>('/v1/operation/roster-warm', {
    method: 'POST', body: JSON.stringify(body),
  })
}

export function startRosterResult(sessionId: number, body: JsonObject, requestKey: string) {
  return request<RosterJob>(`/v1/operation/sessions/${sessionId}/roster-results`, {
    method: 'POST', headers: { 'Idempotency-Key': requestKey }, body: JSON.stringify(body),
  })
}

// 계산 상태: RUNNING / DONE(result_id) / FAILED / LOST
export function rosterResultStatus(sessionId: number, versionId: number, requestKey: string) {
  const query = new URLSearchParams({ input_version_id: String(versionId), request_key: requestKey })
  return request<RosterJob>(`/v1/operation/sessions/${sessionId}/roster-results?${query}`)
}

// 저장한 추천 근무표 다시 불러오기(근무표 전체 = detail).
export function loadRosterResult(resultId: number) {
  return request<StoredRosterResult>(`/v1/operation/results/${resultId}?view=detail`)
}

// 말로 고치기: 사장님 말 + 바꿀 수 있는 칸·지금 값·결과 요약 → 바꿀 칸(범위 검사됨)·답장. 직원은 별칭만 보낸다.
export function rosterChat(body: JsonObject) {
  return request<RosterChatReply>('/v1/operation/roster-chat', { method: 'POST', body: JSON.stringify(body) })
}

// 추천 근무표 결과 설명(두세 문장). 결과에 없는 숫자가 있으면 fallback(코드 문장)을 돌려준다.
export function rosterExplain(body: { result: JsonObject; fallback: string }) {
  return request<{ source: 'LLM' | 'TEMPLATE'; text: string }>('/v1/operation/roster-explain', { method: 'POST', body: JSON.stringify(body) })
}

// 저장한 추천 근무표의 줄 서는 모습(재생 기록). 조건·근무조는 서버가 저장된 결과에서 꺼낸다. 저장하지 않는다.
export function rosterReplay(resultId: number, day: string, choice: string) {
  return request<OperationTrace>(`/v1/operation/results/${resultId}/roster-replay?day=${encodeURIComponent(day)}&choice=${encodeURIComponent(choice)}`)
}
