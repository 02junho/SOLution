import type { JsonObject } from '../../../types/workflow'
import type { RosterChatReply } from '../roster/rosterTypes'
import { MAX_TEAM } from '../roster/team'
import type { Person, Team } from '../roster/team'
import { MACHINE_COUNTS, TARGET_WAIT_MINUTES, wageFloor } from '../workspace/operationInput'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'

/** 말로 고칠 때 시급 상한(말실수 방지). 경력·가산 시급까지 받되 터무니없는 값은 막는다. */
const MAX_CHAT_WAGE = 30_000

/** 바꿀 수 있는 칸 정의(서버가 이 범위로 AI 답을 검사한다). */
/** label은 답장에 쓰는 짧은 이름, hint는 AI가 칸을 알아듣게 돕는 설명, unit은 숫자 뒤에 붙일 단위(선택). */
type FieldBase = { key: string; label: string; hint?: string; unit?: string }

export type ChatField =
  | (FieldBase & { type: 'int'; min: number; max: number })
  | (FieldBase & { type: 'bool'; time_min?: string; time_max?: string })
  | (FieldBase & { type: 'choice' | 'choices'; choices: string[]; choice_labels?: Record<string, string> })
  | (FieldBase & { type: 'time'; min: string; max: string; step_min: number })


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
    { key: 'target_wait_min', label: '목표 대기 시간', unit: '분', hint: '주문 후 음료를 받기까지 걸리는 시간. 손님 10명 중 9명(90%)이 이 시간 안에 받게 사람을 둔다', type: 'int', min: Math.min(...TARGET_WAIT_MINUTES), max: Math.max(...TARGET_WAIT_MINUTES) },
    { key: 'espresso_machines', label: '에스프레소 머신 개수', unit: '대', type: 'int', min: Math.min(...MACHINE_COUNTS), max: Math.max(...MACHINE_COUNTS) },
    { key: 'blenders', label: '블렌더 개수', unit: '대', type: 'int', min: Math.min(...MACHINE_COUNTS), max: Math.max(...MACHINE_COUNTS) },
    { key: 'owner_working', label: '사장님 근무', hint: '사장님이 매장에서 직접 일하는지', type: 'bool' },
    { key: 'owner_days', label: '사장님 근무 요일', type: 'choices', choices: dataDays, choice_labels: WEEKDAY_LABEL },
    { key: 'owner_start', label: '사장님 출근 시각', type: 'time', min: open, max: close, step_min: 30 },
    { key: 'owner_end', label: '사장님 퇴근 시각', type: 'time', min: open, max: close, step_min: 30 },
    { key: 'hourly_wage', label: '직원 시급', unit: '원', hint: '최저시급(min) 아래로는 못 내림', type: 'int', min: wageFloor(), max: MAX_CHAT_WAGE },
    { key: 'workers', label: '직원 명단', hint: 'worker_changes로 더하기·빼기·고치기, 직원은 alias로', type: 'bool', time_min: open, time_max: close },
  ]
}

/**
 * 별칭은 명단 순서가 아니라 직원 번호(id)로 붙인다. 대화 중에 앞 직원을 빼도 앞 대화의 "P3"가 다른 사람을 가리키지 않게.
 */
const aliasOf = (p: Person) => `P${p.id}`

/**
 * 사장님이 쓴 말 속 직원 이름 → 별칭(P1…). AI에는 이름을 보내지 않는다("직원 G가 토요일에 못 나온대" → "P7이 …").
 * 긴 이름부터 바꿔 "직원 A"가 "직원 AB" 안에서 먼저 바뀌지 않게 한다.
 */
export function toAliases(text: string, people: Person[]): string {
  const named = people.map((p) => ({ name: p.name.trim(), alias: aliasOf(p) })).filter((x) => x.name)
  named.sort((a, b) => b.name.length - a.name.length)
  return named.reduce((out, x) => out.split(x.name).join(x.alias), text)
}

/** AI 답장 속 별칭(P1…) → 화면에 보이는 직원 이름. 명단에 없는 번호는 그대로 둔다. */
export function toNames(text: string, people: Person[]): string {
  return text.replace(/\bP(\d{1,2})\b/g, (whole, n: string) => people.find((p) => p.id === Number(n))?.name || whole)
}

/** 바로 앞 대화(별칭으로 바꾼 말). "그럼 그렇게 해 줘"처럼 앞 말을 가리킬 때 AI가 본다. 최근 4줄까지. */
export type ChatTurn = { role: 'owner' | 'assistant'; text: string }
export const MAX_HISTORY = 4
export const pushHistory = (list: ChatTurn[], ...turns: ChatTurn[]): ChatTurn[] => [...list, ...turns].slice(-MAX_HISTORY)

/** 직원은 이름 없이 별칭(P1…)만 보낸다. */
export const chatWorkers = (people: Person[]): JsonObject[] =>
  people.map((p) => ({ alias: aliasOf(p), days: p.days, start: p.start, end: p.end, max_hours: Number(p.maxHours), minor: p.minor }))

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
  /** nextId: 새 직원에게 줄 가장 작은 번호(화면이 지금까지 쓴 번호 + 1). 없으면 지금 명단 기준 */
  defaults: { open: string; close: string; nextId?: number },
): { next: RosterConditions; rows: string[]; changed: boolean } {
  let next = { ...c, team: { ...c.team } }
  const rows = new Set<string>()
  for (const { key, value } of reply.changes) {
    if (key === 'target_wait_min' && typeof value === 'number') next.targetWaitSec = value * 60
    else if (key === 'espresso_machines' && typeof value === 'number') next.espresso = value
    else if (key === 'blenders' && typeof value === 'number') next.blenders = value
    else if (key === 'owner_working' && typeof value === 'boolean') next.owner = value
    else if (key === 'hourly_wage' && typeof value === 'number') {
      // 조건 카드의 시급 고르기와 같게: 가게 시급과 직원마다의 시급을 함께 바꾼다(계산은 직원 시급을 쓴다).
      next.wage = String(value)
      next.team.people = next.team.people.map((p) => ({ ...p, wage: String(value) }))
    }
    else if (key === 'owner_days' && Array.isArray(value)) next.team.ownerDays = value as Weekday[]
    else if (key === 'owner_start' && typeof value === 'string') next.team.ownerStart = value
    else if (key === 'owner_end' && typeof value === 'string') next.team.ownerEnd = value
    else continue
    if (ROW_OF[key]) rows.add(ROW_OF[key])
  }
  let people = [...next.team.people]
  const byAlias = new Map(people.map((p) => [aliasOf(p), p.id]))
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
      const id = Math.max(defaults.nextId ?? 1, ...people.map((p) => p.id + 1))
      people.push({ id, name: `추가 직원 ${id}`, wage: next.wage, minor: false, days: [], start: defaults.open, end: defaults.close, maxHours: '14', ...patch })
    } else if (change.op === 'remove') {
      const id = byAlias.get(change.alias)
      // 마지막 한 명은 빼지 않는다. 실제로 뺀 게 없으면 바뀐 줄로도 표시하지 않는다.
      if (id == null || people.length <= 1) continue
      people = people.filter((p) => p.id !== id)
    } else if (change.op === 'update') {
      const id = byAlias.get(change.alias)
      const target = people.find((p) => p.id === id)
      if (!target) continue
      const merged = { ...target, ...patch }
      // 서버에서도 막지만, 합친 결과의 시작이 끝보다 늦으면 받지 않는다.
      if (merged.start >= merged.end) continue
      people = people.map((p) => (p.id === id ? merged : p))
    } else continue
    rows.add('team')
  }
  next = { ...next, team: { ...next.team, people } }
  const changed = rows.size > 0
  return { next, rows: [...rows], changed }
}

/**
 * 말로 바꾼 내용 모으기. 답장은 "칸: 값 / 칸: 값" 모양이라 칸 이름으로 나눠, 같은 칸은 마지막 값만 남긴다.
 * 반영하지 못한 안내 같은 다른 문장은 그대로 붙인다.
 */
export function mergeChanges(list: string[], reply: string): string[] {
  const out = [...list]
  for (const part of reply.split(' / ').map((x) => x.trim().replace(/\.$/, '')).filter(Boolean)) {
    const label = part.includes(':') ? part.slice(0, part.indexOf(':')) : null
    const at = label ? out.findIndex((x) => x.startsWith(`${label}:`)) : -1
    if (at >= 0) out[at] = part
    else out.push(part)
  }
  return out
}

/**
 * 말로 바꿀 수 있는 것 안내(칸 정의에서 만든다. 칸이 늘면 안내도 같이 는다).
 * 사장님 근무 칸 여러 개는 하나로, 직원 명단은 할 수 있는 일로 풀어 쓴다.
 */
export function editableText(fields: ChatField[]): string {
  const out: string[] = []
  for (const f of fields) {
    if (f.key === 'workers') out.push('직원(더하기·빼기·일할 수 있는 요일·시간)')
    else if (f.key.startsWith('owner_')) {
      if (!out.includes('사장님 근무(요일·시간)')) out.push('사장님 근무(요일·시간)')
    } else out.push(f.label)
  }
  return out.join(' · ')
}
