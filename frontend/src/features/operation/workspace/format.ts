// 운영 화면 숫자·이름 표시 규칙. 사장님 화면이라 운영안 코드(CURRENT·ALT_A·ALT_C)는 이름으로만 보인다.

export const decimal = (n: number | null | undefined, digits = 1) =>
  typeof n === 'number' && Number.isFinite(n)
    ? n.toLocaleString('ko-KR', { maximumFractionDigits: digits, minimumFractionDigits: digits })
    : '—'
export const integer = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? Math.round(n).toLocaleString('ko-KR') : '—'
export const minutes = (sec: number | null | undefined) =>
  typeof sec === 'number' && Number.isFinite(sec) ? `${decimal(sec / 60, 1)}분` : '—'
/** 1분 미만은 초로(짧은 대기를 0.3분처럼 보이지 않게) */
export const duration = (sec: number | null | undefined) =>
  typeof sec === 'number' && Number.isFinite(sec) ? (sec < 60 ? `${Math.round(sec)}초` : minutes(sec)) : '—'
export const percent = (n: number | null | undefined, digits = 0) =>
  typeof n === 'number' && Number.isFinite(n) ? `${decimal(n * 100, digits)}%` : '—'
export const won = (n: number | null | undefined) =>
  typeof n === 'number' && Number.isFinite(n) ? `${integer(n)}원` : '—'
export const hours = (sec: number | null | undefined) =>
  typeof sec === 'number' && Number.isFinite(sec) ? `${decimal(sec / 3600, sec % 3600 ? 1 : 0)}시간` : '—'
const signed = (sec: number) => `${sec < 0 ? '−' : '+'}${decimal(Math.abs(sec) / 60, 1)}`
/** 현재 대비 차이(분)와 95% 범위. 범위가 0을 지나면 "차이 없음"으로 읽는다. */
export function diffText(delta: number, low: number, high: number) {
  if (low <= 0 && 0 <= high) return `차이 없음 (${signed(low)} ~ ${signed(high)}분)`
  return `${signed(delta)}분 (${signed(low)} ~ ${signed(high)})`
}

export const CHOICE_KEYS = ['CURRENT', 'ALT_A', 'ALT_C'] as const
export const CHOICE_TITLE: Record<string, string> = { CURRENT: '현재 방식', ALT_A: '서로 돕기', ALT_C: '한 명 추가' }
export const CONFIRM_LABEL: Record<string, string> = {
  CURRENT: '현재 방식으로 확정·저장',
  ALT_A: '서로 돕기로 확정·저장',
  ALT_C: '한 명 추가로 확정·저장',
}
export const WORKER_LABEL: Record<string, string> = { OWNER: '사장님', STAFF_1: '직원 1', STAFF_2: '직원 2', STAFF_3: '직원 3' }
export const TASK_LABEL: Record<string, string> = {
  ALL_TASKS: '모든 일',
  ORDER_HANDOFF: '주문·전달',
  PREPARATION: '제조',
  ORDER_HANDOFF_HELP_PREPARATION: '주문·전달 (제조 도움)',
  PREPARATION_HELP_ORDER_HANDOFF: '제조 (주문 도움)',
  ORDER: '주문',
  MAKE: '제조',
  FLEX: '모든 일',
}
export const hourOf = (hhmm: string) => Number(hhmm.slice(0, 2)) + Number(hhmm.slice(3, 5)) / 60
export const DAY_START_HOUR = 7
export const pos = (h: number) => `${((h - DAY_START_HOUR) / 12) * 100}%`
export const span = (start: number, end: number) => `${((end - start) / 12) * 100}%`
