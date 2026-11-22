import { loadOperationResult } from '../../../api/operationApi'
import type { JsonObject } from '../../../types/workflow'

/*
 * 쉬운 화면 "점심 인원"을 1번(세 방법 비교)으로 볼지 2번(추천 근무표)으로 볼지 고르는 스위치.
 * - 새로 시작할 때: 주소에 ?mode=roster가 있으면 2번. 팀이 2번으로 정하면 ROSTER_MODE를 true로 바꾸는 한 줄이면 된다.
 * - 이어서 열 때(하던 일·저장한 계획): 주소와 상관없이 결과 종류로 고른다(근무표 결과면 2번, 아니면 1번).
 */
export const ROSTER_MODE = new URLSearchParams(window.location.search).get('mode') === 'roster'

/**
 * 추천 근무표를 처음에 어떤 범위로 짤지. 'week' = 일주일(요일 7개), 'day' = 가장 바쁜 요일 하루(빠름, 멘토링 대안).
 * 배포 서버가 느려 일주일이 어려우면 이 한 줄을 'day'로 바꾼다. 사장님은 조건 카드의 "고치기"에서 언제든 바꿀 수 있다.
 */
export const ROSTER_SCOPE_DEFAULT: 'week' | 'day' = 'week'

/** 결과가 추천 근무표(ROSTER_OPTIONS)인지. 결과가 없으면 저장된 조건에 가게 데이터(시간대별 주문)가 있는지로 본다. */
export async function isRosterResult(resultId: number | null | undefined, input: JsonObject | null): Promise<boolean> {
  if (resultId) {
    const response = await loadOperationResult(resultId, 'summary')
    const summary = (response.data as { summary?: { result_kind?: string } } | null | undefined)?.summary
    return summary?.result_kind === 'ROSTER_OPTIONS'
  }
  const form = input?.operation_form
  return ROSTER_MODE || Boolean(form && typeof form === 'object' && !Array.isArray(form) && 'orders_by_slot' in form)
}
