import { loadOperationResult } from '../../../api/operationApi'
import type { JsonObject } from '../../../types/workflow'

/*
 * 쉬운 화면 "점심 인원"을 1번(세 방법 비교)으로 볼지 2번(추천 근무표)으로 볼지 고르는 스위치.
 * - 새로 시작할 때: 기본은 2번(추천 근무표). 주소에 ?mode=lunch가 있을 때만 1번. 예전 주소 ?mode=roster도 2번이다.
 * - 이어서 열 때(하던 일·저장한 계획): 주소와 상관없이 결과 종류로 고른다(근무표 결과면 2번, 아니면 1번).
 */
export const LUNCH_MODE_PARAM = 'lunch'
export const ROSTER_MODE = new URLSearchParams(window.location.search).get('mode') !== LUNCH_MODE_PARAM

/**
 * 추천 근무표를 처음에 어떤 범위로 짤지. 'week' = 일주일(요일 7개), 'day' = 가장 바쁜 요일 하루(빠름, 멘토링 대안).
 * 배포 서버가 느려 일주일이 어려우면 이 한 줄을 'day'로 바꾼다. 사장님은 조건 카드의 "고치기"에서 언제든 바꿀 수 있다.
 */
export const ROSTER_SCOPE_DEFAULT: 'week' | 'day' = 'week'

/** 결과가 추천 근무표(ROSTER_OPTIONS)인지. 결과가 없으면 저장된 조건에 가게 데이터(시간대별 주문)가 있는지로 본다. */
export async function isRosterResult(resultId: number | null | undefined, input: JsonObject | null): Promise<boolean> {
  if (resultId) {
    const response = await loadOperationResult(resultId, 'summary')
    // 판별을 못 하면 일반 결과 화면으로 잘못 열지 않고 오류로 알린다(업무를 다시 열면 다시 판별한다).
    if (response.status !== 'ok') throw new Error(response.message ?? '결과를 불러오지 못했어요. 잠시 뒤 다시 열어 주세요.')
    const summary = (response.data as { summary?: { result_kind?: string } } | null | undefined)?.summary
    return summary?.result_kind === 'ROSTER_OPTIONS'
  }
  const form = input?.operation_form
  // 주소(?mode=lunch)는 새로 시작할 때만 본다. 이어서 열 때는 저장된 조건만으로 고른다(1번 업무가 2번으로 열리지 않게).
  return Boolean(form && typeof form === 'object' && !Array.isArray(form) && 'orders_by_slot' in form)
}
