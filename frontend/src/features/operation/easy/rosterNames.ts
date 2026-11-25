import type { OptionKey } from '../roster/rosterTypes'

/*
 * 추천 근무표 세 안의 이름(쉬운 화면). 결과 화면·저장한 계획·하던 일 목록이 모두 이 이름을 쓴다(한 곳에서 관리).
 * 작은 파일로 둔 이유: 쉬운 화면 첫 화면(목록)이 불러도 근무표 화면 코드가 같이 실리지 않게.
 */
export const OPTION_NAME: Record<OptionKey, string> = { SAVE: '인건비 절약 근무표', RECOMMENDED: '균형 근무표', ROOMY: '여유 근무표' }
