// 추천 근무표(운영 2번)용 따라 하며 배우기 단계. 쉬운 화면 가이드(features/easy/tour.ts)와 같은 모양의 단계를 쓰고,
// 1단계(말로 적기)는 공통 단계를 그대로 쓴다. 근무표는 데이터 고르기와 세 근무표 비교가 더 있어서 7단계다.
import { currentStep } from '../../easy/tour.ts'
import type { TourPhase, TourStep } from '../../easy/tour.ts'

export const ROSTER_TOUR_TOTAL = 7

/** 근무표 화면 안의 단계: 데이터 고르기(pick) / 조건 확인(confirm). 그 밖이면 null. */
export type RosterStage = 'pick' | 'confirm' | null

/** 결과 화면에서 넘겨 보는 단계(4~7). 화면의 data-tour 값과 맞춘다(EasyRosterResult). */
export const ROSTER_RESULT_STEPS: TourStep[] = [
  {
    key: 'verdict', target: 'verdict', waitsForAction: false, place: 'side',
    title: '처음에는 최종 추천 근무표를 보여 드려요',
    body: '새로 뽑을 직원이 몇 명인지와 인건비만 보셔도 돼요.',
  },
  {
    key: 'detail', target: 'detail', waitsForAction: false, place: 'side',
    title: '요일마다 누가 몇 시에 일하는지 나와요',
    body: '노란 칸은 새로 뽑을 직원 자리예요. "근무표 인쇄"로 직원에게 나눠 줄 수 있어요.',
  },
  {
    key: 'compare', target: 'compare', waitsForAction: false, place: 'side',
    title: '세 근무표를 비교해 골라요',
    body: '인건비 절약·균형·여유 근무표의 대기시간과 인건비를 비교해요. 최종 추천 표시가 붙은 안부터 보셔도 돼요. 위 근무표가 바로 바뀌어요. 조건을 바꾸고 싶으면 아래 칸에 말로 적으세요. 다시 계산할지 먼저 물어봐요.',
  },
  {
    key: 'save', target: 'save', waitsForAction: false, place: 'side',
    title: '마음에 들면 저장해요',
    body: '저장한 근무표는 위의 "저장한 계획"에서 다시 볼 수 있어요.',
  },
]

/** 지금 보여 줄 단계와 번호(1~7). 계산 중에는 숨긴다(null). */
export function rosterStep(phase: TourPhase, stage: RosterStage, resultIndex: number): { step: TourStep; number: number } | null {
  if (phase === 'start' || phase === 'ask') return currentStep(phase, 'operation', 0)
  if (phase === 'confirm' && stage === 'pick') {
    return {
      number: 2,
      step: {
        key: 'source', target: 'source', waitsForAction: true, place: 'side',
        title: '어떤 데이터로 만들지 골라요',
        body: '처음이면 "마이샵 매출 데이터로 만들기"를 누르세요. 포스기 파일이 있으면 올려도 돼요.',
      },
    }
  }
  if (phase === 'confirm' && stage === 'confirm') {
    return {
      number: 3,
      step: {
        key: 'confirm', target: 'confirm-area', waitsForAction: true, place: 'side',
        title: '조건이 맞는지 봐요',
        body: '틀린 곳은 "고치기"를 누르거나, 아래 "말로 고치기" 칸에 "금요일엔 제가 가게에 못 나가요"처럼 사장님 말투 그대로 적으면 돼요. 맞으면 파란 버튼을 누르세요.',
      },
    }
  }
  if (phase === 'result') {
    const index = Math.min(Math.max(resultIndex, 0), ROSTER_RESULT_STEPS.length - 1)
    return { number: 4 + index, step: ROSTER_RESULT_STEPS[index] }
  }
  return null
}
