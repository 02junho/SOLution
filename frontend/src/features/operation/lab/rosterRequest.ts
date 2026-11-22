import type { JsonObject } from '../../../types/workflow'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { StorePlan, Weekday } from '../workspace/storeFile'
import { fromMin, toMin } from './team'
import type { Person, Team } from './team'
import type { RosterOptions } from './rosterTypes'

/*
 * 추천 근무표 계산 요청 만들기. 실험실(WeeklyCard)과 쉬운 화면(EasyRoster)이 같이 쓴다.
 * 요일마다 그 요일 데이터로 만든 운영 조건 + 그날 사장님 근무를 담고, 직원 명단은 가능 요일·시간·주 최대 시간만 보낸다.
 */

/** 그날 사장님 근무 시간: 사장님 출퇴근을 그날 영업시간 안으로 자른다. 근무하지 않는 날이거나 남는 시간이 없으면 null. */
export function ownerWindow(
  ownerWorking: boolean,
  team: Pick<Team, 'ownerDays' | 'ownerStart' | 'ownerEnd'>,
  day: Weekday,
  open: string,
  close: string,
): { start: string; end: string } | null {
  if (!ownerWorking || !team.ownerDays.includes(day)) return null
  const start = fromMin(Math.max(toMin(team.ownerStart), toMin(open)))
  const end = fromMin(Math.min(toMin(team.ownerEnd), toMin(close)))
  return start < end ? { start, end } : null
}

/** 요일별 계산 본문. 데이터가 없거나 문제가 있는 요일은 skipped에 이유를 담는다. */
export function rosterDays(
  weekdays: Weekday[],
  planFor: (day: Weekday) => StorePlan,
  formFor: (plan: StorePlan) => JsonObject,
  ownerWorking: boolean,
  team: Pick<Team, 'ownerDays' | 'ownerStart' | 'ownerEnd'>,
): { days: JsonObject[]; skipped: string[] } {
  const days: JsonObject[] = []
  const skipped: string[] = []
  for (const day of weekdays) {
    const plan = planFor(day)
    if (!plan.open || !plan.close || plan.problems.length) {
      skipped.push(`${WEEKDAY_LABEL[day]}요일: ${plan.problems[0] ?? '시간대 데이터가 없어요.'}`)
      continue
    }
    const owner = ownerWindow(ownerWorking, team, day, plan.open, plan.close)
    days.push({
      day,
      operation_form: { ...formFor(plan), is_owner_working: owner !== null },
      ...(owner ? { owner_start_time: owner.start, owner_end_time: owner.end } : {}),
    })
  }
  return { days, skipped }
}

/** 직원 명단 → 서버 본문. 이름은 화면에서 구분하는 용도로만 쓰고 AI에는 보내지 않는다(말로 고치기는 별칭만). */
export const rosterWorkers = (people: Person[]): JsonObject[] =>
  people.map((p) => ({
    worker_key: p.name.trim(),
    name: p.name.trim(),
    hourly_wage_krw: Number(p.wage),
    is_minor: p.minor,
    max_weekly_hours: Number(p.maxHours),
    available: Object.fromEntries(p.days.map((d) => [d, [p.start, p.end]])),
  }))

type Option = RosterOptions['options'][number]

/** 배정 하나의 휴게. slot_id는 "요일-그날 직원 근무조 순번"이라 그날 사장님을 뺀 근무조 순서로 찾는다. */
export function breaksOf(option: Option, slotId: string): { start_time: string; end_time: string }[] {
  const cut = slotId.lastIndexOf('-')
  const day = slotId.slice(0, cut)
  const index = Number(slotId.slice(cut + 1))
  const shifts = option.days[day]?.shifts.filter((s) => !s.is_owner) ?? []
  return shifts[index]?.breaks ?? []
}

/** 그날 사장님 근무(없으면 null). */
export function ownerShift(option: Option, day: string): { start_time: string; end_time: string } | null {
  const shift = option.days[day]?.shifts.find((s) => s.is_owner)
  return shift ? { start_time: shift.start_time, end_time: shift.end_time } : null
}
