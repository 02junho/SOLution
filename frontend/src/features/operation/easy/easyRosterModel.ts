import { breaksOf, ownerShift } from '../lab/rosterRequest'
import type { OptionKey, RosterOptions } from '../lab/rosterTypes'
import { WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'

/*
 * 쉬운 화면 추천 근무표의 계산 없는 도우미(화면 글자·표 모양). 숫자는 모두 서버 결과에서 가져오고 여기서 만들지 않는다.
 */

type Option = RosterOptions['options'][number]

export const OPTION_NAME: Record<OptionKey, string> = { SAVE: '아끼는 근무표', RECOMMENDED: '추천 근무표', ROOMY: '여유 근무표' }

/** 대기(초) → 사장님이 읽기 쉬운 말. 1분 안은 "1분 안", 그 위는 반올림한 분. */
export function waitText(sec: number | null | undefined): string {
  if (sec == null) return '—'
  if (sec < 60) return '1분 안'
  return `약 ${Math.round(sec / 60)}분`
}

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

/** 결과에 있는 요일만 월~일 순서로. */
export const shownDays = (data: RosterOptions): Weekday[] => WEEKDAYS.filter((d) => d in data.days)

/** 요일 평균 "바쁜 시간 가장 긴 대기". */
export function averagePeak(option: Option, days: Weekday[]): number | null {
  const values = days.map((d) => option.peak_wait_sec[d]).filter((v): v is number => v != null)
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

/** 추천 한 줄. 요일마다 더한 사람 수가 같으면 "N명씩", 다르면 가장 많은 날 기준으로 말한다. */
export function headline(option: Option, days: Weekday[]): string {
  const extras = days.map((d) => option.extra_by_day[d] ?? 0)
  const most = Math.max(0, ...extras)
  if (most === 0) return '지금 꼭 필요한 인원으로 충분해요'
  const busy = days.filter((d) => (option.extra_by_day[d] ?? 0) > 0)
  if (busy.length === days.length && new Set(extras).size === 1) return `바쁜 시간에 ${most}명씩 더 두면 돼요`
  if (busy.length === days.length) return `바쁜 시간에 요일마다 ${Math.min(...extras)}~${most}명 더 두면 돼요`
  if (busy.length > 3) return `바쁜 시간에 사람을 더 두는 날이 ${busy.length}일이에요`
  return `${busy.map((d) => WEEKDAY_LABEL[d]).join('·')}요일 바쁜 시간에 사람을 더 두면 돼요`
}

/** 대기가 가장 긴 요일(사람을 더하기 전 기준). "사람을 늘리면" 그래프의 기본 요일. */
export function busiestDay(data: RosterOptions, days: Weekday[]): Weekday | null {
  let best: Weekday | null = null
  let worst = -1
  for (const d of days) {
    const first = data.days[d]?.ladder[0]?.peak_wait_sec
    if (first != null && first > worst) {
      worst = first
      best = d
    }
  }
  return best ?? days[0] ?? null
}

export type LadderBar = { extra: number; label: string; sec: number | null; pick: OptionKey | null; ratio: number }

/** "사람을 늘리면 대기가 얼마나 줄까" 막대. ratio는 가장 긴 대기를 1로 본 높이. */
export function ladderBars(data: RosterOptions, day: Weekday): LadderBar[] {
  const info = data.days[day]
  if (!info) return []
  const top = Math.max(1, ...info.ladder.map((s) => s.peak_wait_sec ?? 0))
  const pickOf = (k: number): OptionKey | null =>
    info.picks.RECOMMENDED === k ? 'RECOMMENDED' : info.picks.ROOMY === k ? 'ROOMY' : info.picks.SAVE === k ? 'SAVE' : null
  return info.ladder.map((s) => ({
    extra: s.extra,
    label: s.extra === 0 ? '꼭 필요한 인원' : `+${s.extra}명`,
    sec: s.peak_wait_sec,
    pick: pickOf(s.extra),
    ratio: s.peak_wait_sec == null ? 0 : s.peak_wait_sec / top,
  }))
}

export type WeekCell = { start: string; end: string; breaks: string[] } | null
export type WeekRow = { key: string; name: string; owner: boolean; hours: number | null; cells: WeekCell[] }

/** 일주일 근무표 줄: 사장님 줄(일하는 날이 있으면) + 일하는 직원 줄. 칸은 days 순서. */
export function weekRows(option: Option, days: Weekday[]): WeekRow[] {
  const rows: WeekRow[] = []
  const ownerCells = days.map((d) => {
    const s = ownerShift(option, d)
    return s ? { start: s.start_time, end: s.end_time, breaks: [] } : null
  })
  if (ownerCells.some(Boolean)) rows.push({ key: '__owner', name: '사장님', owner: true, hours: null, cells: ownerCells })
  for (const w of option.weekly.workers.filter((x) => x.days.length)) {
    rows.push({
      key: w.worker_key,
      name: w.name,
      owner: false,
      hours: w.weekly_work_hours,
      cells: days.map((d) => {
        const a = option.weekly.assignments.find((x) => x.worker_key === w.worker_key && x.day === d)
        return a
          ? { start: a.start_time, end: a.end_time, breaks: breaksOf(option, a.slot_id).map((b) => rangeText(b.start_time, b.end_time)) }
          : null
      }),
    })
  }
  return rows
}

/** 못 채운 자리(요일 칸마다 "시작~끝"). 없으면 null. */
export function unfilledCells(option: Option, days: Weekday[]): string[] | null {
  if (!option.weekly.unfilled.length) return null
  return days.map((d) =>
    option.weekly.unfilled
      .filter((u) => u.day === d)
      .map((u) => rangeText(u.start_time, u.end_time))
      .join(', '),
  )
}

/** "08:00" → "오전 8시", "13:30" → "오후 1시 30분". */
export function clock(hhmm: string): string {
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(3, 5))
  const half = h < 12 ? '오전' : '오후'
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${half} ${hour}시${m ? ` ${m}분` : ''}`
}

/** 근무 시간 글자. 둘 다 정시면 "7~16시", 아니면 "10:30~14:00". */
export function rangeText(start: string, end: string): string {
  const whole = start.endsWith(':00') && end.endsWith(':00')
  const h = (t: string) => String(Number(t.slice(0, 2)))
  return whole ? `${h(start)}~${h(end)}시` : `${h(start)}:${start.slice(3, 5)}~${h(end)}:${end.slice(3, 5)}`
}

/** 계산을 몇 번 돌려 평균 냈는지(결과에 있는 값). 없으면 null. */
export function repetitionsOf(data: RosterOptions): number | null {
  for (const option of data.options) for (const day of Object.values(option.days)) if (day.repetitions) return day.repetitions
  return null
}

/** 근무조 이름(OWNER·STAFF_n) → "사장님 · 직원 2명". 줄 서는 모습에서 일하는 사람을 이름 없이 보여 준다. */
export function staffText(keys: string[]): string {
  const owner = keys.includes('OWNER')
  const staff = keys.filter((k) => k !== 'OWNER').length
  return [owner ? '사장님' : '', staff ? `직원 ${staff}명` : ''].filter(Boolean).join(' · ') || '없음'
}
