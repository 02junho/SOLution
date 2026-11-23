// 따라 하며 배우기(체험형 가이드) 단계. 화면 상태(phase·업무 종류)로 지금 보여 줄 단계를 정한다.
// 사장님이 실제로 보내기·계산을 누르면 화면 상태가 바뀌고, 그에 맞춰 다음 단계가 저절로 나온다.
// 근거: 신한 쏠 쉬운 가이드(연습 화면에서 직접 해 보기), NN/g(억지로 띄우지 말고 필요할 때), 토스 시니어 연구(움직임 대신 멈춘 강조와 글).
import type { EasyFeature } from './route'

export type TourPhase = 'start' | 'ask' | 'confirm' | 'running' | 'result' | 'error' | 'loading'
export type TourStep = {
  key: string
  target: string // data-tour 값
  title: string
  body: string
  /** 사장님이 화면에서 직접 해야 넘어가는 단계면 true (다음 버튼 대신 안내) */
  waitsForAction: boolean
  /** 'side'면 말풍선을 비춘 곳 옆(오른쪽 → 왼쪽)에 먼저 둔다. 단계마다 위·아래·옆으로 튀지 않게(추천 근무표). */
  place?: 'side'
}

export const TOUR_TOTAL = 5

/** 결과 화면에서 넘겨 보는 단계(3~5). 0부터 센다. */
export function resultSteps(feature: EasyFeature | null): TourStep[] {
  return [
    {
      key: 'verdict', target: 'verdict', waitsForAction: false,
      title: '맨 위가 추천이에요',
      body: '이 한 줄만 보셔도 돼요. 아래는 자세한 내용이에요.',
    },
    feature === 'operation'
      ? {
          key: 'detail', target: 'detail', waitsForAction: false,
          title: '누가 몇 시에 무엇을 하는지 나와요',
          body: '파란 테두리가 지금과 달라진 곳이에요. "배치표 인쇄"로 직원에게 나눠 줄 수 있어요.',
        }
      : {
          key: 'detail', target: 'detail', waitsForAction: false,
          title: '거래처에 보낼 문구도 있어요',
          body: '"주문 문구 보기"를 누르면 거래처별 문구가 나와요. 복사해서 문자로 보내면 돼요.',
        },
    {
      key: 'save', target: 'save', waitsForAction: false,
      title: '마음에 들면 저장해요',
      body: '저장한 계획은 위의 "저장한 계획"에서 다시 볼 수 있어요.',
    },
  ]
}

/**
 * 지금 보여 줄 단계와 번호(1~5). 결과 화면 안에서는 resultIndex(0~2)로 넘긴다.
 * 계산 중에는 가이드를 잠시 숨긴다(null).
 */
export function currentStep(phase: TourPhase, feature: EasyFeature | null, resultIndex: number): { step: TourStep; number: number } | null {
  if (phase === 'start') {
    return {
      number: 1,
      step: {
        key: 'input', target: 'input', waitsForAction: true,
        title: '하고 싶은 일을 적어 보세요',
        body: '“일주일 근무표 만들어 줘”처럼 평소 말투면 돼요. 다 적으면 "보내기"를 누르세요. 아래 카드를 눌러도 돼요.',
      },
    }
  }
  if (phase === 'ask') {
    return {
      number: 1,
      step: {
        key: 'choices', target: 'choices', waitsForAction: true,
        title: '어떤 일인지 골라 주세요',
        body: '말만으로는 헷갈릴 때 이렇게 물어봐요. 둘 중 하나를 누르세요.',
      },
    }
  }
  if (phase === 'confirm') {
    return {
      number: 2,
      step: {
        key: 'confirm', target: 'confirm', waitsForAction: true,
        title: '조건이 맞는지 봐요',
        body: '틀린 곳만 "고치기"로 바꾸면 돼요. 맞으면 파란 버튼을 누르세요.',
      },
    }
  }
  if (phase === 'result') {
    const steps = resultSteps(feature)
    const index = Math.min(Math.max(resultIndex, 0), steps.length - 1)
    return { number: 3 + index, step: steps[index] }
  }
  return null
}

const SEEN_KEY = 'solution.easy.tour.seen'

// 브라우저 저장소는 막혀 있을 수 있어서(사생활 보호 모드 등) 실패해도 화면은 그대로 둔다.
export function tourSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

export function markTourSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // 기록하지 못하면 다음 방문에 권유 카드가 한 번 더 보일 뿐이다.
  }
}
