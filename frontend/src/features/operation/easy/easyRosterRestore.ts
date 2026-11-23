import type { JsonObject } from '../../../types/workflow'
import { DEFAULT_TARGET_WAIT_SEC, equipmentBody, equipmentFrom, wageFloor } from '../workspace/operationInput'
import type { Equipment } from '../workspace/operationInput'
import { ownerWindow } from '../roster/rosterRequest'
import { WEEKDAYS } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import type { Person } from '../roster/team'
import type { RosterConditions } from './easyRosterChat'

/*
 * 다시 불러오기: 저장한 추천 근무표 결과에 남아 있는 계산 요청(요일별 운영 조건 + 직원 명단)으로
 * 그때의 조건을 다시 채우고, 원본 판매 파일 없이 그 숫자로 다시 계산할 요청을 만든다.
 * 원본 파일은 저장하지 않으므로(브라우저 안에서만 읽음) 요일별 시간대 주문·메뉴 같은 정리한 숫자만 쓴다.
 */

export type StoredRequest = { days: JsonObject[]; workers: JsonObject[] }

const obj = (v: unknown): JsonObject => (v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObject) : {})
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** 요일 → 그날 운영 조건(저장된 그대로). 월~일 순서. */
export function storedDays(request: StoredRequest): { day: Weekday; form: JsonObject; ownerStart: string | null; ownerEnd: string | null }[] {
  const out = []
  for (const day of WEEKDAYS) {
    const row = request.days.find((d) => d.day === day)
    if (!row) continue
    out.push({ day, form: obj(row.operation_form), ownerStart: str(row.owner_start_time), ownerEnd: str(row.owner_end_time) })
  }
  return out
}

/** 시간대 주문의 첫 칸 시작 ~ 마지막 칸 끝. 칸 이름은 "07:00-08:00". */
export function hoursOf(form: JsonObject): { open: string; close: string } | null {
  const keys = Object.keys(obj(form.orders_by_slot)).sort()
  if (!keys.length) return null
  return { open: keys[0].slice(0, 5), close: keys[keys.length - 1].slice(-5) }
}

export type RestoredFacts = {
  days: Weekday[]
  open: string
  close: string
  dailyOrders: number
  peak: { start: string; end: string } | null
  dataDays: number | null
  fileName: string | null
}

/** 확인 카드에 보일 숫자(요일 평균 하루 주문, 가장 이른 오픈 ~ 가장 늦은 마감, 첫 요일의 바쁜 시간). */
export function restoredFacts(request: StoredRequest): RestoredFacts | null {
  const days = storedDays(request)
  const hours = days.map((d) => hoursOf(d.form)).filter((h): h is { open: string; close: string } => h !== null)
  if (!days.length || !hours.length) return null
  const orders = days.map((d) => num(d.form.daily_orders) ?? 0)
  const first = days[0].form
  const source = obj(first.store_source)
  // 요일마다 저장된 출처의 일수는 "그 요일이 며칠이었나"라서, 더하면 전체 일수가 된다.
  const counts = days.map((d) => num(obj(d.form.store_source).days))
  const total = counts.every((n) => n !== null) ? (counts as number[]).reduce((a, b) => a + b, 0) : null
  return {
    days: days.map((d) => d.day),
    open: hours.map((h) => h.open).sort()[0],
    close: hours.map((h) => h.close).sort()[hours.length - 1],
    dailyOrders: Math.round(orders.reduce((a, b) => a + b, 0) / orders.length),
    peak: str(first.peak_start_time) && str(first.peak_end_time) ? { start: first.peak_start_time as string, end: first.peak_end_time as string } : null,
    dataDays: total,
    fileName: str(source.file_name),
  }
}

/** 저장된 요청 → 그때의 조건. 직원은 요일마다 같은 시간대만 다룬다(첫 가능 요일의 시간). */
export function restoreConditions(request: StoredRequest, fallback: { open: string; close: string }): RosterConditions {
  const days = storedDays(request)
  const first = days[0]?.form ?? {}
  const ownerDays = days.filter((d) => d.ownerStart && d.ownerEnd)
  const wage = num(first.hourly_wage_krw) ?? wageFloor()
  const people: Person[] = request.workers.map((w, i) => {
    const available = obj(w.available)
    const workDays = WEEKDAYS.filter((d) => Array.isArray(available[d]))
    const span = (workDays.length ? available[workDays[0]] : null) as unknown
    const [start, end] = Array.isArray(span) && span.length === 2 ? (span as string[]) : [fallback.open, fallback.close]
    return {
      id: i + 1,
      name: str(w.name) ?? str(w.worker_key) ?? `직원 ${i + 1}`,
      wage: String(num(w.hourly_wage_krw) ?? wage),
      minor: w.is_minor === true,
      days: workDays,
      start,
      end,
      maxHours: String(num(w.max_weekly_hours) ?? 14),
    }
  })
  return {
    targetWaitSec: num(first.target_wait_sec) ?? DEFAULT_TARGET_WAIT_SEC,
    espresso: num(first.espresso_machines) ?? 1,
    blenders: num(first.blenders) ?? 1,
    owner: ownerDays.length > 0 || days.some((d) => d.form.is_owner_working === true),
    wage: String(wage),
    team: {
      people,
      // 사장님이 일하지 않던 결과면 저장된 근무 요일이 없다. 다시 켤 때 쓸 수 있게 처음 화면과 같은 기본(데이터가 있는 평일)을 둔다.
      ownerDays: ownerDays.length ? ownerDays.map((d) => d.day) : days.map((d) => d.day).filter((d) => d !== 'SAT' && d !== 'SUN'),
      // 저장된 요일별 시간은 처음 시간을 그날 영업시간 안으로 자른 값이다. 가장 이른 시작·가장 늦은 끝으로 되돌리면
      // 다시 계산할 때 요일마다 다시 잘라도 저장된 시간과 같아진다(첫 요일 값으로 다른 요일이 좁아지지 않게).
      ownerStart: ownerDays.map((d) => d.ownerStart as string).sort()[0] ?? fallback.open,
      ownerEnd: ownerDays.map((d) => d.ownerEnd as string).sort().at(-1) ?? fallback.close,
    },
  }
}

/** 조건 → 기계·목표 대기(공통 규칙 equipmentFrom). 처음 계산과 다시 계산이 같이 쓴다. */
export const equipmentOf = (c: RosterConditions): Equipment => equipmentFrom(c.espresso, c.blenders, c.targetWaitSec)

/** 운영 조건 하나에 지금 조건(시급·기계·목표 대기)을 덮는다. 칸 이름은 폼 본문 규칙(equipmentBody) 하나로 만든다. */
export function patchForm(form: JsonObject, c: RosterConditions): JsonObject {
  const { espresso_machines: _e, blenders: _b, target_wait_sec: _t, ...rest } = form
  void _e
  void _b
  void _t
  return { ...rest, hourly_wage_krw: Number(c.wage), ...equipmentBody(equipmentOf(c)) }
}

/** 다시 계산할 요일별 본문. 사장님 근무는 그날 영업시간 안으로 자른다(처음 계산과 같은 규칙). */
export function restoredDayBodies(request: StoredRequest, c: RosterConditions): JsonObject[] {
  return storedDays(request).map(({ day, form }) => {
    const hours = hoursOf(form)
    const owner = hours ? ownerWindow(c.owner, c.team, day, hours.open, hours.close) : null
    return {
      day,
      operation_form: { ...patchForm(form, c), is_owner_working: owner !== null },
      ...(owner ? { owner_start_time: owner.start, owner_end_time: owner.end } : {}),
    }
  })
}
