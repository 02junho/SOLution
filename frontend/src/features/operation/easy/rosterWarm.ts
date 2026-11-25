/*
 * 추천 근무표 미리 계산 순서(운영 2번 속도 개선 E·G). 계산 자체는 서버가 하고(저장 없음), 여기서는 "무엇을 어떤 순서로"만 정한다.
 * - 조건 확인 카드(E): 지금 조건 하나
 * - 결과 화면(G): 사장님이 자주 바꾸는 목표 대기의 다른 값들. 지금 값과 가까운 것부터, 같으면 짧은 대기부터
 *   (예: 5분이면 3분 → 7분). 지금 조건은 방금 계산해서 기억에 있다.
 */
import type { RosterConditions } from './easyRosterChat'

export type WarmStage = 'confirm' | 'result'

/** 목표 대기(분) 다른 값들을 미리 계산할 순서로. */
export function otherWaits(currentMin: number, choices: readonly number[]): number[] {
  return choices
    .filter((m) => m !== currentMin)
    .sort((a, b) => Math.abs(a - currentMin) - Math.abs(b - currentMin) || a - b)
}

/** 단계별로 미리 계산할 조건 목록(앞에서부터 차례로 보낸다). */
export function warmConditions(stage: WarmStage, cond: RosterConditions, waitChoices: readonly number[]): RosterConditions[] {
  if (stage === 'confirm') return [cond]
  return otherWaits(cond.targetWaitSec / 60, waitChoices).map((m) => ({ ...cond, targetWaitSec: m * 60 }))
}
