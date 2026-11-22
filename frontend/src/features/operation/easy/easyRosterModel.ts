import { breaksOf, ownerShift } from '../lab/rosterRequest'
import type { OptionKey, RosterOptions } from '../lab/rosterTypes'
import { WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'

/*
 * 쉬운 화면 추천 근무표의 계산 없는 도우미(화면 글자·표 모양). 숫자는 모두 서버 결과에서 가져오고 여기서 만들지 않는다.
 */

type Option = RosterOptions['options'][number]

export { OPTION_NAME } from './rosterNames'

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
/**
 * 결론 한 줄. 새로 뽑을 직원이 있으면 그걸 먼저 말한다(표에 노란 줄이 있는데 "지금 인원으로 충분"이라고 하면 헷갈림).
 * 그다음 바쁜 시간에 사람을 더 두는지(세 안의 차이)를 붙인다.
 */
export function headline(option: Option, days: Weekday[]): string {
  const hires = option.shortfall?.more_people_under_15h ?? 0
  const busy = busyText(option, days)
  if (hires > 0) return busy ? `직원 ${hires}명을 더 뽑고, ${busy}` : `직원 ${hires}명을 더 뽑으면 돼요`
  return busy || '지금 직원으로 충분해요'
}

/** 바쁜 시간에 더 두는 사람 이야기("바쁜 시간에 1명씩 더 두면 돼요"). 더 두지 않으면 빈 글자. */
function busyText(option: Option, days: Weekday[]): string {
  const extras = days.map((d) => option.extra_by_day[d] ?? 0)
  const most = Math.max(0, ...extras)
  if (most === 0) return ''
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
/** 그 자리의 휴게: 서버가 자리마다 실어 준 값(breaks)을 먼저 쓰고, 예전 결과(값 없음)만 근무조 순서로 찾는다. */
function breaksFor(option: Option, a: { slot_id: string; breaks?: { start_time: string; end_time: string }[] }) {
  return a.breaks ?? breaksOf(option, a.slot_id)
}

/** hire = 명단으로 못 채워 새로 뽑을 알바 줄(서버 new_hires) */
/** pay = 주 예상 급여(서버 값: 주 근무시간 × 시급, 세전·주휴 없음). 사장님 줄은 null */
export type WeekRow = { key: string; name: string; owner: boolean; hire?: boolean; hours: number | null; pay?: number | null; cells: WeekCell[] }

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
      pay: w.base_wage_krw ?? null,
      cells: days.map((d) => {
        const a = option.weekly.assignments.find((x) => x.worker_key === w.worker_key && x.day === d)
        return a
          ? { start: a.start_time, end: a.end_time, breaks: breaksFor(option, a).map((b) => shiftText(b.start_time, b.end_time)) }
          : null
      }),
    })
  }
  // 새로 뽑을 알바: 서버가 못 채운 자리를 같은 규칙(하루 한 근무, 주 15시간 미만)으로 나눠 준 그대로 보여 준다.
  for (const h of option.new_hires ?? []) {
    rows.push({
      key: h.worker_key,
      name: h.name,
      owner: false,
      hire: true,
      hours: h.weekly_work_hours,
      pay: h.base_wage_krw ?? null,
      cells: days.map((d) => {
        const a = h.assignments.find((x) => x.day === d)
        return a ? { start: a.start_time, end: a.end_time, breaks: breaksFor(option, a).map((b) => shiftText(b.start_time, b.end_time)) } : null
      }),
    })
  }
  return rows
}

/** 못 채운 자리(요일 칸마다 "시작~끝"). 새 알바 줄(new_hires)로 보여 주면 null. 예전에 저장한 결과에만 나온다. */
export function unfilledCells(option: Option, days: Weekday[]): string[] | null {
  if (!option.weekly.unfilled.length || option.new_hires) return null
  return days.map((d) =>
    option.weekly.unfilled
      .filter((u) => u.day === d)
      .map((u) => shiftText(u.start_time, u.end_time))
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

/** 세 근무표 비교 카드: 추천 근무표와 견준 한 줄("추천보다 대기 +40초 · 인건비 −320,000원"). 추천 자신이면 null. */
export function versusText(option: Option, recommended: Option, days: Weekday[]): string | null {
  if (option.key === recommended.key) return null
  const a = averagePeak(option, days)
  const b = averagePeak(recommended, days)
  const sec = a != null && b != null ? Math.round(a - b) : null
  // 몇 초 차이는 사장님이 느끼기 어려워 "거의 같아요"로(화면의 대기도 분 단위로 반올림해 보인다)
  const wait = sec == null ? null : Math.abs(sec) < SAME_WAIT_SEC ? '대기는 거의 같아요' : `대기 ${sec > 0 ? '+' : '−'}${Math.abs(sec)}초`
  const diff = option.plan_cost_krw - recommended.plan_cost_krw
  const cost = diff === 0 ? '인건비 같음' : `인건비 ${diff > 0 ? '+' : '−'}${won(Math.abs(diff))}`
  return `추천보다 ${[wait, cost].filter(Boolean).join(' · ')}`
}

/** 이보다 작은 대기 차이(초)는 "거의 같아요"로 보인다. */
export const SAME_WAIT_SEC = 10

/** 표 칸 근무 시간 글자: 늘 "7:00~16:30" 모양(칸끼리 표기가 섞이지 않게). */
export function shiftText(start: string, end: string): string {
  return shiftParts(start, end).join('')
}

/** 표 칸에서 줄을 바꿀 때 "~" 뒤에서만 바꾸도록 두 조각으로("7:00~", "12:00"). */
export function shiftParts(start: string, end: string): [string, string] {
  const t = (x: string) => `${Number(x.slice(0, 2))}:${x.slice(3, 5)}`
  return [`${t(start)}~`, t(end)]
}

/** 문장 속 시간 글자. 둘 다 정시면 "7~16시", 아니면 "10:30~14:00". */
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

/**
 * 사람을 더해도 대기가 더 줄지 않던 때(서버 verification.capacity_limited). 같은 시간대는 요일을 묶어 한 문장으로.
 * 예: "월·화요일 오전 8시대는 사람을 더 넣어도 손님 대기가 더 줄지 않아요. …" 없으면 null.
 */
export function capacityText(option: RosterOptions['options'][number], days: Weekday[]): string | null {
  const bySlot = new Map<string, Weekday[]>()
  for (const d of days) {
    const slot = option.days[d]?.verification?.capacity_limited?.slot
    if (slot) bySlot.set(slot, [...(bySlot.get(slot) ?? []), d])
  }
  if (!bySlot.size) return null
  const where = [...bySlot].map(([slot, ds]) => `${ds.map((d) => WEEKDAY_LABEL[d]).join('·')}요일 ${clock(slot.slice(0, 5))}대`).join(', ')
  return `${where}는 사람을 더 넣어도 손님 대기가 더 줄지 않아요. 머신이 한 번에 만들 수 있는 양이 한계라서, 에스프레소 머신이나 블렌더를 늘리면 줄어들 수 있어요.`
}

/**
 * 근무표 기간에 따른 낱말. 요일 하나만 계산했으면(하루 근무표) "주" 대신 "하루", 제목은 "○요일", 빈 시간은 "이날".
 * 직원 규칙(주 15시간 미만)은 하루 근무표에서도 그대로라 그 문구는 바꾸지 않는다.
 */
export function periodOf(days: Weekday[]): { per: string; title: string; within: string } {
  return days.length === 1
    ? { per: '하루', title: `${WEEKDAY_LABEL[days[0]]}요일`, within: '이날' }
    : { per: '주', title: '일주일', within: '일주일에' }
}
