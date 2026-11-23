import { WEEKDAYS } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'

/* 일주일 근무표의 직원 명단·사장님 근무. 쉬운 화면 근무표와 말로 고치기가 같이 쓴다. */

export const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
export const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

export type Person = {
  id: number
  name: string
  wage: string
  minor: boolean
  days: Weekday[]
  start: string
  end: string
  maxHours: string
}
/** 직원 명단 최대(서버 한도와 같다). */
export const MAX_TEAM = 20
export const WEEKDAYS_ONLY: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI']
export const ALL_DAYS: Weekday[] = [...WEEKDAYS]
/** 가게 하루를 반으로 나눈 경계(30분 단위). 예시 직원의 오전·오후 가능 시간과 사장님 기본 근무에 쓴다. */
const midday = (open: string, close: string) => fromMin(Math.round((toMin(open) + toMin(close)) / 60) * 30)
/** 오전조 끝·오후조 시작을 한낮에서 얼마나 떨어뜨릴지(분). 07~19시 가게면 오전조 07~16시, 오후조 10~19시. */
const SHIFT_REACH_MIN = 180
export const morningEnd = (open: string, close: string) => fromMin(Math.min(toMin(close), toMin(midday(open, close)) + SHIFT_REACH_MIN))
const afternoonStart = (open: string, close: string) =>
  fromMin(Math.max(toMin(open), toMin(midday(open, close)) - SHIFT_REACH_MIN))
/** 직원 명단과 사장님 근무(요일·시간). 말로 고치기도 바꿀 수 있게 쉬운 화면이 들고 있다. */
export type Team = { people: Person[]; ownerDays: Weekday[]; ownerStart: string; ownerEnd: string }
export const exampleTeam = (wage: string, open: string, close: string, weekdays: Weekday[]): Team => ({
  people: example(wage, open, close),
  ownerDays: weekdays,
  ownerStart: open,
  ownerEnd: morningEnd(open, close),
})
/** 시연용 예시 명단. 가능 시간은 가게 영업시간에서 정한다(오전조 = 오픈~한낮+3시간, 오후조 = 한낮-3시간~마감). */
export const example = (wage: string, open: string, close: string): Person[] => {
  const am = morningEnd(open, close)
  const pm = afternoonStart(open, close)
  return [
    { id: 1, name: '직원 A', wage, minor: false, days: WEEKDAYS_ONLY, start: open, end: am, maxHours: '40' },
    { id: 2, name: '직원 B', wage, minor: false, days: WEEKDAYS_ONLY, start: pm, end: close, maxHours: '40' },
    { id: 3, name: '직원 C', wage, minor: false, days: ALL_DAYS, start: open, end: close, maxHours: '30' },
    { id: 4, name: '직원 D', wage, minor: false, days: WEEKDAYS_ONLY, start: open, end: am, maxHours: '14' },
    { id: 5, name: '직원 E', wage, minor: false, days: ALL_DAYS, start: pm, end: close, maxHours: '20' },
    { id: 6, name: '직원 F', wage, minor: false, days: ['TUE', 'THU', 'SAT', 'SUN'], start: open, end: close, maxHours: '14' },
    { id: 7, name: '직원 G', wage, minor: false, days: ['MON', 'WED', 'FRI', 'SAT', 'SUN'], start: open, end: close, maxHours: '14' },
    { id: 8, name: '직원 H', wage, minor: false, days: ALL_DAYS, start: open, end: close, maxHours: '14' },
  ]
}
