import type { JsonObject } from '../../../types/workflow'
import type { ChatField } from '../lab/RosterChat'
import type { RosterChatReply } from '../lab/rosterTypes'
import { MAX_TEAM } from '../lab/team'
import type { Person, Team } from '../lab/team'
import { MACHINE_COUNTS, TARGET_WAIT_MINUTES, wageFloor } from '../workspace/operationInput'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'

/*
 * 쉬운 화면 말로 고치기: AI에 보낼 칸 정의·지금 값과, 서버가 검사한 답을 조건에 반영하는 순수 함수.
 * 칸 이름·범위는 데이터로 보내고(프롬프트에 예시 문장 없음), 서버가 같은 정의로 AI 답을 다시 검사한다.
 */

export type RosterConditions = {
  targetWaitSec: number
  espresso: number
  blenders: number
  owner: boolean
  wage: string
  team: Team
}

/** 바꿀 수 있는 칸. 메뉴 유형·바쁜 시간은 아직 말로 못 바꾼다. */
export function chatFields(open: string, close: string, dataDays: Weekday[]): ChatField[] {
  return [
    { key: 'target_wait_min', label: '목표 대기', unit: '분', hint: '주문 후 받기까지, 10명 중 9명이 이 안에 받게', type: 'int', min: Math.min(...TARGET_WAIT_MINUTES), max: Math.max(...TARGET_WAIT_MINUTES) },
    { key: 'espresso_machines', label: '에스프레소 머신', unit: '대', type: 'int', min: Math.min(...MACHINE_COUNTS), max: Math.max(...MACHINE_COUNTS) },
    { key: 'blenders', label: '블렌더', unit: '대', type: 'int', min: Math.min(...MACHINE_COUNTS), max: Math.max(...MACHINE_COUNTS) },
    { key: 'owner_working', label: '사장님 근무', hint: '사장님이 매장에서 직접 일하는지', type: 'bool' },
    { key: 'owner_days', label: '사장님 근무 요일', type: 'choices', choices: dataDays, choice_labels: WEEKDAY_LABEL },
    { key: 'owner_start', label: '사장님 출근 시각', type: 'time', min: open, max: close, step_min: 30 },
    { key: 'owner_end', label: '사장님 퇴근 시각', type: 'time', min: open, max: close, step_min: 30 },
    { key: 'hourly_wage', label: '직원 시급', unit: '원', hint: '최저시급(min) 아래로는 못 내림', type: 'int', min: wageFloor(), max: 100_000 },
    { key: 'workers', label: '직원 명단', hint: 'worker_changes로 더하기·빼기·고치기, 직원은 alias로', type: 'bool', time_min: open, time_max: close },
  ]
}

const aliasOf = (i: number) => `P${i + 1}`

/**
 * 사장님이 쓴 말 속 직원 이름 → 별칭(P1…). AI에는 이름을 보내지 않는다("직원 G가 토요일에 못 나온대" → "P7이 …").
 * 긴 이름부터 바꿔 "직원 A"가 "직원 AB" 안에서 먼저 바뀌지 않게 한다.
 */
export function toAliases(text: string, people: Person[]): string {
  const named = people.map((p, i) => ({ name: p.name.trim(), alias: aliasOf(i) })).filter((x) => x.name)
  named.sort((a, b) => b.name.length - a.name.length)
  return named.reduce((out, x) => out.split(x.name).join(x.alias), text)
}

/** AI 답장 속 별칭(P1…) → 화면에 보이는 직원 이름. 명단에 없는 번호는 그대로 둔다. */
export function toNames(text: string, people: Person[]): string {
  return text.replace(/\bP(\d{1,2})\b/g, (whole, n: string) => people[Number(n) - 1]?.name || whole)
}

/** 바로 앞 대화(별칭으로 바꾼 말). "그럼 그렇게 해 줘"처럼 앞 말을 가리킬 때 AI가 본다. 최근 4줄까지. */
export type ChatTurn = { role: 'owner' | 'assistant'; text: string }
export const MAX_HISTORY = 4
export const pushHistory = (list: ChatTurn[], ...turns: ChatTurn[]): ChatTurn[] => [...list, ...turns].slice(-MAX_HISTORY)

/** 직원은 이름 없이 별칭(P1…)만 보낸다. */
export const chatWorkers = (people: Person[]): JsonObject[] =>
  people.map((p, i) => ({ alias: aliasOf(i), days: p.days, start: p.start, end: p.end, max_hours: Number(p.maxHours), minor: p.minor }))

export function chatState(c: RosterConditions, extra: { open: string; close: string; busy: string | null; dailyOrders: number | null }): JsonObject {
  return {
    target_wait_min: c.targetWaitSec / 60,
    espresso_machines: c.espresso,
    blenders: c.blenders,
    owner_working: c.owner,
    owner_days: c.team.ownerDays,
    owner_start: c.team.ownerStart,
    owner_end: c.team.ownerEnd,
    hourly_wage: Number(c.wage),
    open_time: extra.open,
    close_time: extra.close,
    busy_time: extra.busy,
    daily_orders: extra.dailyOrders,
  }
}

/** 확인 카드에서 강조할 줄(칸 key → 줄 이름). */
const ROW_OF: Record<string, string> = {
  target_wait_min: 'target',
  espresso_machines: 'machines',
  blenders: 'machines',
  owner_working: 'owner',
  owner_days: 'owner',
  owner_start: 'owner',
  owner_end: 'owner',
  hourly_wage: 'wage',
}

/** 서버가 검사한 변경만 반영한다. 반환: 새 조건, 바뀐 줄 이름, 바뀐 것이 있는지. */
export function applyReply(
  c: RosterConditions,
  reply: RosterChatReply,
  defaults: { open: string; close: string },
): { next: RosterConditions; rows: string[]; changed: boolean } {
  let next = { ...c, team: { ...c.team } }
  const rows = new Set<string>()
  for (const { key, value } of reply.changes) {
    if (key === 'target_wait_min' && typeof value === 'number') next.targetWaitSec = value * 60
    else if (key === 'espresso_machines' && typeof value === 'number') next.espresso = value
    else if (key === 'blenders' && typeof value === 'number') next.blenders = value
    else if (key === 'owner_working' && typeof value === 'boolean') next.owner = value
    else if (key === 'hourly_wage' && typeof value === 'number') next.wage = String(value)
    else if (key === 'owner_days' && Array.isArray(value)) next.team.ownerDays = value as Weekday[]
    else if (key === 'owner_start' && typeof value === 'string') next.team.ownerStart = value
    else if (key === 'owner_end' && typeof value === 'string') next.team.ownerEnd = value
    else continue
    if (ROW_OF[key]) rows.add(ROW_OF[key])
  }
  let people = [...next.team.people]
  const byAlias = new Map(people.map((p, i) => [aliasOf(i), p.id]))
  for (const change of reply.worker_changes) {
    const f = (change.fields ?? {}) as Partial<{ days: Person['days']; start: string; end: string; max_hours: number; minor: boolean }>
    const patch: Partial<Person> = {
      ...(f.days ? { days: f.days } : {}),
      ...(f.start ? { start: f.start } : {}),
      ...(f.end ? { end: f.end } : {}),
      ...(f.max_hours != null ? { maxHours: String(f.max_hours) } : {}),
      ...(f.minor != null ? { minor: f.minor } : {}),
    }
    if (change.op === 'add' && people.length < MAX_TEAM) {
      const id = Math.max(0, ...people.map((p) => p.id)) + 1
      people.push({ id, name: `새 직원 ${people.length + 1}`, wage: next.wage, minor: false, days: [], start: defaults.open, end: defaults.close, maxHours: '14', ...patch })
    } else if (change.op === 'remove') {
      const id = byAlias.get(change.alias)
      if (people.length > 1) people = people.filter((p) => p.id !== id)
    } else if (change.op === 'update') {
      const id = byAlias.get(change.alias)
      people = people.map((p) => (p.id === id ? { ...p, ...patch } : p))
    } else continue
    rows.add('team')
  }
  next = { ...next, team: { ...next.team, people } }
  const changed = rows.size > 0
  return { next, rows: [...rows], changed }
}
