// 쉬운 화면의 "이전"(한 단계 뒤로)과 "취소" 규칙. 어느 단계에서 눌러도 갈 곳이 하나로 정해져 있어야
// 사장님이 길을 잃지 않는다. 화면 위 이전 버튼과 따라 하며 배우기의 이전 버튼이 같은 규칙을 쓴다.
import type { EasyRoute } from './hashRoute'

export type BackPhase = 'start' | 'ask' | 'confirm' | 'running' | 'result' | 'error' | 'loading'
export type BackState = {
  phase: BackPhase
  route: EasyRoute['kind']
  /** 이번에 본 결과가 화면에 남아 있는지(조건 확인으로 돌아와도 결과로 다시 갈 수 있게) */
  hasResult: boolean
  /** 하던 일 목록에서 연 업무인지(처음 말하기 단계가 없는 업무) */
  resumed: boolean
  /** 업무 종류가 정해졌는지(조건 확인 단계가 있는지) */
  hasFeature: boolean
}
export type BackAction =
  | { kind: 'phase'; phase: 'start' | 'confirm' | 'result'; clearChat?: boolean; cancelRun?: boolean }
  | { kind: 'route'; route: EasyRoute }

export type Back = { label: string; action: BackAction }

export function backOf(s: BackState): Back | null {
  if (s.route === 'sessions' || s.route === 'plans') return { label: '홈으로', action: { kind: 'route', route: { kind: 'home' } } }
  if (s.route === 'plan') return { label: '저장한 계획 목록', action: { kind: 'route', route: { kind: 'plans' } } }

  const toList: Back = { label: '하던 일 목록', action: { kind: 'route', route: { kind: 'sessions' } } }
  const toStart: Back = { label: '다시 말하기', action: { kind: 'phase', phase: 'start', clearChat: true } }
  switch (s.phase) {
    case 'start':
      return s.route === 'session' ? toList : null
    case 'loading':
      return toList
    case 'ask':
      return toStart
    case 'confirm':
      if (s.hasResult) return { label: '결과로 돌아가기', action: { kind: 'phase', phase: 'result' } }
      return s.resumed ? toList : toStart
    case 'running':
      return { label: '계산 그만두기', action: { kind: 'phase', phase: 'confirm', cancelRun: true } }
    case 'result':
      return { label: '조건 다시 보기', action: { kind: 'phase', phase: 'confirm' } }
    case 'error':
      if (s.hasFeature) return { label: '조건 다시 보기', action: { kind: 'phase', phase: 'confirm' } }
      return s.route === 'session' ? toList : { label: '홈으로', action: { kind: 'route', route: { kind: 'home' } } }
  }
}
