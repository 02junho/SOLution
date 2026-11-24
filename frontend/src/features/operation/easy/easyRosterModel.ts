import { breaksOf, ownerShift } from '../roster/rosterRequest'
import type { OptionKey, RosterOptions } from '../roster/rosterTypes'
import { averageWait, validWait, waitText } from '../roster/rosterWait'
import { OPTION_NAME } from './rosterNames'
import { WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'

/*
 * 쉬운 화면 추천 근무표의 계산 없는 도우미(화면 글자·표 모양). 숫자는 모두 서버 결과에서 가져오고 여기서 만들지 않는다.
 */

type Option = RosterOptions['options'][number]

export { OPTION_NAME } from './rosterNames'

export { waitText } from '../roster/rosterWait'

export const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

/** 결과에 있는 요일만 월~일 순서로. */
export const shownDays = (data: RosterOptions): Weekday[] => WEEKDAYS.filter((d) => d in data.days)

/** 요일별 바쁜 시간대 최대 P90 중 가장 큰 값(초). 주간 비교 카드의 보조 지표. */
export function worstPeak(option: Option, days: Weekday[]): number | null {
  const values = days.map((d) => option.peak_wait_sec[d]).filter(validWait)
  return values.length ? Math.max(...values) : null
}

/** 요일별 바쁜 시간대 최대 P90의 평균(초). 상단·비교 카드·저장 요약의 공통 지표. */
export function averagePeak(option: Option, days: Weekday[]): number | null {
  return averageWait(days.map((d) => option.peak_wait_sec[d]))
}

/** 현재 고른 안의 요약. 저장 당시의 문장(소수점 분) 대신 원본 결과로 다시 만든다. */
export function optionSummary(data: RosterOptions, option: Option, days: Weekday[]): string {
  const current = waitText(averagePeak(option, days))
  const save = data.options.find((o) => o.key === 'SAVE')
  const base = save ? waitText(averagePeak(save, days)) : '—'
  const comparable = save && days.every((d) => validWait(save.peak_wait_sec[d]) === validWait(option.peak_wait_sec[d]))
  const wait = comparable && base !== '—' && current !== '—' && base !== current ? `${base} → ${current}` : current
  const label = days.length === 1 ? '바쁜 시간 대기' : '바쁜 시간 대기 (요일 평균)'
  const hires = option.shortfall.more_people_under_15h
  return `${OPTION_NAME[option.key]}: ${label} ${wait}, ${periodOf(days).per} 인건비 ${won(option.plan_cost_krw)}, 직원 ${option.weekly.people_used}명(모두 주 15시간 미만)${hires > 0 ? `, 직원 ${hires}명 더 필요` : ''}.`
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
  // 더 배치하는 사람도 지금 직원이면 새로 뽑을 필요가 없다는 걸 같이 말한다(고용인지 배치만 바꾼 건지 헷갈리지 않게).
  return busy ? `${busy} · 새로 뽑지 않고 지금 직원으로 채워요` : '지금 직원으로 충분해요'
}

/** 바쁜 시간에 더 두는 사람 이야기("바쁜 시간에 1명씩 더 배치하면 돼요"). 더 두지 않으면 빈 글자. */
function busyText(option: Option, days: Weekday[]): string {
  const extras = days.map((d) => option.extra_by_day[d] ?? 0)
  const most = Math.max(0, ...extras)
  if (most === 0) return ''
  const busy = days.filter((d) => (option.extra_by_day[d] ?? 0) > 0)
  if (busy.length === days.length && new Set(extras).size === 1) return `바쁜 시간에 ${most}명씩 더 배치하면 돼요`
  if (busy.length === days.length) return `바쁜 시간에 요일마다 ${Math.min(...extras)}~${most}명 더 배치하면 돼요`
  if (busy.length > 3) return `바쁜 시간에 사람을 더 배치하는 날이 ${busy.length}일이에요`
  return `${busy.map((d) => WEEKDAY_LABEL[d]).join('·')}요일 바쁜 시간에 사람을 더 배치하면 돼요`
}

/** 최종 절약 근무표의 대기가 가장 긴 요일. 그래프와 비교 카드가 같은 값을 사용한다. */
export function busiestDay(data: RosterOptions, days: Weekday[]): Weekday | null {
  const save = data.options.find((o) => o.key === 'SAVE')
  let best: Weekday | null = null
  let worst = -1
  for (const d of days) {
    const first = save?.peak_wait_sec[d]
    if (validWait(first) && first > worst) {
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
  const top = Math.max(1, ...info.ladder.map((s) => s.peak_wait_sec).filter(validWait))
  const pickOf = (k: number): OptionKey | null =>
    info.picks.RECOMMENDED === k ? 'RECOMMENDED' : info.picks.ROOMY === k ? 'ROOMY' : info.picks.SAVE === k ? 'SAVE' : null
  return info.ladder.map((s) => ({
    extra: s.extra,
    label: s.extra === 0 ? '꼭 필요한 인원' : `+${s.extra}명`,
    sec: s.peak_wait_sec,
    pick: pickOf(s.extra),
    ratio: validWait(s.peak_wait_sec) ? s.peak_wait_sec / top : 0,
  }))
}

export type FinalWaitBar = { key: OptionKey; label: string; sec: number | null; recommended: boolean; ratio: number }

/** 선택한 요일의 최종 근무표 대기. 비교 카드(averagePeak)와 같은 원본 값을 읽는다.
 *  인원 탐색용 ladder는 근무조/휴게/보강 전이라 이 그래프의 값으로 사용하지 않는다. */
export function finalWaitBars(data: RosterOptions, day: Weekday, recommended: OptionKey): FinalWaitBar[] {
  if (!data.days[day]) return []
  const options = data.options
  const top = Math.max(1, ...options.map((o) => o.peak_wait_sec[day]).filter(validWait))
  return options.map((o) => {
    const raw = o.peak_wait_sec[day]
    const sec = validWait(raw) ? raw : null
    return {
      key: o.key,
      label: OPTION_NAME[o.key].replace(/ 근무표$/, ''),
      sec,
      recommended: o.key === recommended,
      ratio: sec === null ? 0 : sec / top,
    }
  })
}

/** extra: 인건비 절약 근무표에는 없고 이 안에서 더 둔 근무(바쁠 때 더 배치한 사람). */
export type WeekCell = { start: string; end: string; breaks: string[]; extra?: boolean } | null
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

/** "08:00" → "8시", "13:30" → "13시 30분". */
export function clock(hhmm: string): string {
  // 표의 시간(16:30)과 맞춰 24시간제로 쓴다.
  const h = Number(hhmm.slice(0, 2))
  const m = Number(hhmm.slice(3, 5))
  return `${h}시${m ? ` ${m}분` : ''}`
}

/** 세 근무표 비교 카드: 추천 근무표와 견준 한 줄("추천보다 대기 +40초 · 인건비 −320,000원"). 추천 자신이면 null. */
export function versusText(option: Option, recommended: Option, days: Weekday[]): string | null {
  if (option.key === recommended.key) return null
  // 카드에 표시된 평균과 같은 요일 기준으로 비교한다. 측정된 요일이 다르면 대기 차이를 표시하지 않는다.
  const sameDays = days.every((d) => validWait(option.peak_wait_sec[d]) === validWait(recommended.peak_wait_sec[d]))
  const a = averagePeak(option, days)
  const b = averagePeak(recommended, days)
  const sec = sameDays && a != null && b != null ? Math.round(a) - Math.round(b) : null
  // 표시한 두 대기시간(초)의 차이로 계산해 화면 숫자와 맞춘다. 10초 미만은 기존대로 안내한다.
  const wait = !sameDays ? '대기 비교 불가(측정 요일 다름)' : sec == null ? null : Math.abs(sec) < SAME_WAIT_SEC ? '대기는 거의 같아요' : `대기 ${sec > 0 ? '+' : '−'}${Math.abs(sec)}초`
  const diff = option.plan_cost_krw - recommended.plan_cost_krw
  if (sameDays && a != null && b != null && a === b && diff === 0 &&
      days.every((d) => option.peak_wait_sec[d] === recommended.peak_wait_sec[d]) &&
      option.weekly != null && recommended.weekly != null && option.shortfall != null && recommended.shortfall != null &&
      option.weekly.people_used === recommended.weekly.people_used &&
      option.shortfall.more_people_under_15h === recommended.shortfall.more_people_under_15h &&
      option.shortfall.unfilled_hours === recommended.shortfall.unfilled_hours) {
    return '추천안과 예상 대기·인건비·채용 필요 인원이 같아요'
  }
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
 * 예: "월·화요일 8시대는 사람을 더 넣어도 손님 대기가 더 줄지 않아요. …" 없으면 null.
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

/**
 * 바쁜 시간 표시용: 이어 붙은 구간은 하나로(8~11시 + 11~14시 → 8~14시). 계산은 구간마다 따로 재지만,
 * 사장님에게는 "바쁜 시간이 왜 두 개지?"가 되지 않게 이어진 것은 합쳐 보여 준다.
 */
export function mergedWindows(windows: { start_time: string; end_time: string }[]): { start: string; end: string }[] {
  const sorted = [...windows].sort((a, b) => a.start_time.localeCompare(b.start_time))
  const out: { start: string; end: string }[] = []
  for (const w of sorted) {
    const last = out[out.length - 1]
    if (last && w.start_time <= last.end) last.end = w.end_time > last.end ? w.end_time : last.end
    else out.push({ start: w.start_time, end: w.end_time })
  }
  return out
}

/**
 * AI 설명을 읽기 쉽게: 다섯 자리 넘는 숫자에 쉼표(1491240원 → 1,491,240원)를 넣고 문장마다 나눈다.
 * 글자는 바꾸지 않고 보이는 모양만 바꾼다(서버가 숫자를 검사한 문장 그대로).
 */
export function noteSentences(text: string): string[] {
  const grouped = text.replace(/(?<![\d.,])\d{5,}(?![\d.,])/g, (n) => Number(n).toLocaleString('ko-KR'))
  return grouped
    .split(/(?<=[다요]\.)\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 바쁠 때 더 배치한 근무 표시: 인건비 절약 근무표(사람을 더하지 않은 안)의 그날 직원 근무와 견줘, 같은 시간 근무가 없는 칸에 extra를 붙인다.
 * 같은 시간 근무가 여러 개면 하나씩 짝지어 지운다. 절약 안 자신이면 그대로 돌려준다.
 */
export function markExtraShifts(rows: WeekRow[], option: Option, save: Option | undefined, days: Weekday[]): WeekRow[] {
  if (!save || save.key === option.key) return rows
  const left = days.map((d) => {
    const bag = new Map<string, number>()
    for (const s of save.days[d]?.shifts ?? []) {
      if (s.is_owner) continue
      const k = `${s.start_time}-${s.end_time}`
      bag.set(k, (bag.get(k) ?? 0) + 1)
    }
    return bag
  })
  const used = days.map(() => new Map<string, number>())
  // 먼저 짝이 있는 칸을 다 지우고, 남은 칸만 extra로 본다(줄 순서에 따라 결과가 바뀌지 않게).
  const extra = rows.map((r) =>
    r.cells.map((c, i) => {
      if (!c || r.owner) return false
      const k = `${c.start}-${c.end}`
      const have = (left[i].get(k) ?? 0) - (used[i].get(k) ?? 0)
      if (have > 0) {
        used[i].set(k, (used[i].get(k) ?? 0) + 1)
        return false
      }
      return true
    }),
  )
  return rows.map((r, ri) => ({ ...r, cells: r.cells.map((c, i) => (c && extra[ri][i] ? { ...c, extra: true } : c)) }))
}
