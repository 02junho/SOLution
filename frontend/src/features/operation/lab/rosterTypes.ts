import type { JsonObject } from '../../../types/workflow'

/** ai-server /tools/simulation/daily-roster 응답(operation.daily_roster.v1). */
export type RosterShift = {
  worker_key: string
  is_owner: boolean
  kind: 'OWNER' | 'LONG' | 'SHORT'
  start_time: string
  end_time: string
  breaks: { start_time: string; end_time: string }[]
  span_hours: number
  break_minutes: number
}
export type DailyRoster = {
  model_version: string
  scenario: { start: string; end: string; last_order_time: string; peak_start_time: string; peak_end_time: string }
  repetitions: number
  rules: { long_shift_hours: number; short_shift_hours: number; min_staff: number; max_staff: number }
  required_by_slot: {
    slot: string
    orders: number
    required_staff: number
    owner_present: boolean
    pass_rate: number | null
    on_roster_min: number
    on_roster_max: number
  }[]
  required_fixes: { slot: string; to: number; reason: string }[]
  shifts: RosterShift[]
  coverage: { start_time: string; end_time: string; on_duty: number }[]
  empty_periods: { start_time: string; end_time: string }[]
  verification: {
    with_breaks: boolean
    pass_rate: number
    passes: boolean
    p90_post_order_receipt_sec: number | null
    repairs: { slot: string; added: string; reason: string }[]
  }
  cost: { employee_paid_hours: number; cash_cost_krw: number; basis: string }
  /** 하루 내내 n명(서로 돕기)일 때 대기. "1명 더 쓰면" 비교용 어림값. */
  staff_curve?: {
    staff: number
    day_p90_sec: number | null
    day_pass_rate: number
    by_slot: { slot: string; p90_sec: number | null; pass_rate: number | null }[]
  }[]
  quality_targets?: { max_p90_post_order_receipt_sec: number }
  assumptions: string[]
}

/** ai-server /tools/simulation/weekly-roster 응답(operation.weekly_roster.v1). */
export type WeeklyResult = {
  mode: 'UNDER_15H' | 'WITH_HOLIDAY_PAY'
  assignments: { slot_id: string; day: string; worker_key: string; name: string; start_time: string; end_time: string; work_hours: number }[]
  unfilled: { slot_id: string; day: string; start_time: string; end_time: string; work_hours: number }[]
  workers: {
    worker_key: string
    name: string
    is_minor: boolean
    days: string[]
    weekly_work_hours: number
    weekly_holiday_pay: boolean
    base_wage_krw: number
    holiday_pay_krw: number
    weekly_cost_krw: number
  }[]
  people_used: number
  weekly_cost_krw: number
  holiday_pay_krw: number
}
export type WeeklyRoster = {
  model_version: string
  weekly_mode: string
  slot_count?: number
  results: WeeklyResult[]
  assumptions: string[]
}

/** ai-server /tools/simulation/week-plan 응답(operation.week_plan.v1). */
export type WeekPlanDay = Pick<
  DailyRoster,
  'scenario' | 'required_by_slot' | 'shifts' | 'verification' | 'cost' | 'empty_periods' | 'rules'
>
export type WeekPlan = {
  model_version: string
  weekly_mode: string
  skipped_days: { day: string; reason: string }[]
  results: { mode: WeeklyResult['mode']; days: Record<string, WeekPlanDay>; weekly: Omit<WeeklyResult, 'mode'> | null }[]
  assumptions: string[]
}

/** /tools/simulation/menu-types 응답. 값: 유형 id, 'FOOD'(음료 아님), null(모름). */
export type MenuTypes = { model_version: string; source: 'LLM' | 'UNAVAILABLE'; types: Record<string, string | null> }

/** ai-server /tools/simulation/roster-options 응답(operation.roster_options.v1). */
export type OptionKey = 'SAVE' | 'RECOMMENDED' | 'ROOMY'
export type OptionDay = WeekPlanDay & { peak_wait_sec: number | null; by_window_sec: (number | null)[]; /** 이 요일을 몇 번 돌려 평균 냈는지 */ repetitions?: number }
export type RosterOptions = {
  model_version: string
  min_gain_sec: number
  skipped_days: { day: string; reason: string }[]
  days: Record<
    string,
    {
      windows: { start_time: string; end_time: string }[]
      ladder: { extra: number; peak_wait_sec: number | null; by_window_sec: (number | null)[]; day_p90_sec: number | null }[]
      picks: Record<OptionKey, number>
      slots: string[]
      required_staff: number[]
    }
  >
  options: {
    key: OptionKey
    title: string
    extra_by_day: Record<string, number>
    days: Record<string, OptionDay>
    weekly: Omit<WeeklyResult, 'mode'>
    shortfall: { unfilled_hours: number; more_people_under_15h: number }
    daily_cost_krw: Record<string, number>
    peak_wait_sec: Record<string, number | null>
    plan_cost_krw: number
  }[]
  holiday_compare: { key: OptionKey; days: Record<string, OptionDay>; weekly: Omit<WeeklyResult, 'mode'>; plan_cost_krw: number }
  assumptions: string[]
}

/** 저장한 추천 근무표의 요약(공통 확정이 읽는 모양). */
export type RosterSummary = {
  result_kind: 'ROSTER_OPTIONS'
  model_version: string
  complete: boolean
  recommended_choice_key: OptionKey
  choices: {
    choice_key: OptionKey
    title: string
    peak_wait_sec: number | null
    weekly_cost_krw: number
    people_used: number
    unfilled_hours: number
    more_people_under_15h: number
  }[]
  warnings: { warning_id: string; requires_ack: boolean; choice_keys: OptionKey[] | null; message: string }[]
  message: string
}
/** 계산 시작·상태 응답. DONE이면 result_id와 summary가 있다. */
export type RosterJob = {
  state: 'RUNNING' | 'DONE' | 'FAILED' | 'LOST'
  request_key?: string
  session_id: number
  input_version_id: number
  result_id?: number
  summary?: RosterSummary
}
/** /operation/results/{id}?view=detail 응답. detail.choices는 options와 같고 key 대신 choice_key. */
export type StoredRosterResult = {
  result_id: number
  session_id: number
  input_version_id: number
  confirmed_choice_key?: OptionKey | null
  summary: RosterSummary
  detail: Omit<RosterOptions, 'options' | 'model_version'> & {
    choices: (Omit<RosterOptions['options'][number], 'key'> & { choice_key: OptionKey })[]
    request: { days: JsonObject[]; workers: JsonObject[] }
  }
}

/** 저장된 상세를 화면 모양(RosterOptions)으로 되돌린다. */
export const optionsFromStored = (stored: StoredRosterResult): RosterOptions => ({
  model_version: stored.summary.model_version,
  min_gain_sec: stored.detail.min_gain_sec,
  skipped_days: stored.detail.skipped_days,
  days: stored.detail.days,
  holiday_compare: stored.detail.holiday_compare,
  assumptions: stored.detail.assumptions,
  options: stored.detail.choices.map(({ choice_key, ...rest }) => ({ ...rest, key: choice_key })),
})

/** 말로 고치기 응답. changes·worker_changes는 서버가 칸 정의로 검사한 것만 온다. */
export type RosterChatReply = {
  source: 'LLM' | 'UNAVAILABLE'
  intent: 'EDIT' | 'ASK' | 'RUN' | 'OTHER'
  changes: { key: string; value: unknown }[]
  worker_changes: { op: 'add' | 'remove' | 'update'; alias: string; fields?: Record<string, unknown> }[]
  rejected?: string[]
  reply: string
}

/** AI에 보낼 결과 요약. 대기는 분(소수 한 자리)으로 반올림해 화면 표기와 같은 숫자만 쓰게 한다. */
export function rosterDigest(data: RosterOptions): JsonObject {
  const min = (sec: number | null | undefined) => (sec == null ? null : Math.round(sec / 6) / 10)
  const avg = (xs: (number | null)[]) => {
    const v = xs.filter((x): x is number => x != null)
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
  }
  const days = Object.keys(data.days)
  return {
    min_gain_sec: data.min_gain_sec,
    days: Object.fromEntries(
      days.map((d) => [
        d,
        {
          busy_windows: data.days[d].windows.map((w) => `${w.start_time}~${w.end_time}`),
          peak_wait_min_by_extra: data.days[d].ladder.map((s) => ({ extra: s.extra, peak_wait_min: min(s.peak_wait_sec) })),
          picks: data.days[d].picks,
        },
      ]),
    ),
    options: data.options.map((o) => ({
      key: o.key,
      title: o.title,
      peak_wait_min_avg: min(avg(days.map((d) => o.peak_wait_sec[d] ?? null))),
      weekly_cost_krw: o.plan_cost_krw,
      people_used: o.weekly.people_used,
      unfilled_hours: o.shortfall.unfilled_hours,
      more_people_needed: o.shortfall.more_people_under_15h,
      extra_by_day: o.extra_by_day,
    })),
    holiday_pay_compare: { option: 'RECOMMENDED', weekly_cost_krw: data.holiday_compare.plan_cost_krw, people_used: data.holiday_compare.weekly.people_used },
  }
}
