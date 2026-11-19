import { request } from '../../../api/client'
import type { JsonObject } from '../../../types/workflow'
import catalog from './menu_catalog.json'

/*
 * 운영 실험 폼 값 저장. 저장 입력은 폼 값만 담고({operation_form: {...}}, 대화 입력과 같은 모양),
 * 근무표 세 안은 계산할 때 Spring(OperationInputBuilder)이 만든다. 저장 전에 Spring 운영 입력 만들기
 * (POST /api/v1/operation/input-drafts)로 폼과 같은 규칙을 한 번 검사한다. 저장은 공통 업무 API(event_type=form).
 */

export type MenuOption = (typeof catalog.menus)[number]
/** 이름 표시용 전체 메뉴(저장된 다른 메뉴도 이름으로 보이게). */
export const MENUS: MenuOption[] = catalog.menus
export const DEFAULT_MENU_IDS: string[] = catalog.selected_menu_ids
/** 폼에서 고르는 메뉴. 지금은 기본 5종 고정이고 판매 비중만 바꾼다(메뉴 추가는 확장 기능). */
export const FORM_MENUS: MenuOption[] = DEFAULT_MENU_IDS.map((id) => MENUS.find((m) => m.menu_id === id)).filter(
  (m): m is MenuOption => Boolean(m),
)

/** 해마다 고시되는 최저시급(labor 정책과 같은 값). 이보다 낮으면 저장하지 않는다. */
export const MINIMUM_WAGES: Record<number, number> = { 2026: 10_320, 2027: 10_700 }
export const minimumWage = (year = new Date().getFullYear()) => MINIMUM_WAGES[year] ?? null
/** 근무는 고정 가정: 2명이 07~19시. 서로 돕기·한 명 추가는 바쁜 시간에만 바뀐다. */
export const DAY_HOURS = '07:00~19:00'
/**
 * 바쁜 시간: 입력으로 받지 않는다. 손님 몰림을 정하는 상권 데이터에서 1시간당 주문이 가장 많은 시간대
 * (Spring OperationInputBuilder.PEAK_START~PEAK_END와 같다). 서로 돕기·한 명 추가·휴게 피하기에 쓴다.
 */
export const PEAK = { start: '11:00', end: '14:00' }
/** 저장 입력에서 폼 값을 담는 칸(Spring·대화와 같은 이름). */
export const FORM_KEY = 'operation_form'
export const DEFAULT_LAST_ORDER = '18:45'
export const rushText = (rush: { start: string; end: string }) => `${rush.start}~${rush.end}`
const rushHours = (rush: { start: string; end: string }) => {
  const [sh, sm] = rush.start.split(':').map(Number)
  const [eh, em] = rush.end.split(':').map(Number)
  return (eh * 60 + em - (sh * 60 + sm)) / 60
}
/** "3시간", "2.5시간" */
export const rushLength = (rush: { start: string; end: string }) => `${rushHours(rush)}시간`

// 60·100·150건은 검증용 가상 조건(한산·보통·혼잡). 276건은 을지로입구 카페 상권의 점포당 하루 결제 건수 추정 중앙값
// (data/docs/simulation_assumptions.md "하루 주문 건수 예시").
export const ORDER_PRESETS = [
  { orders: 60, label: '60건' },
  { orders: 100, label: '100건' },
  { orders: 150, label: '150건' },
  { orders: 276, label: '상권 평균 276건' },
]
export const MAX_DAILY_ORDERS = 300
export const SLOW_RUN_ORDERS = 250
// 라스트 오더는 18:30~19:00만 고른다. 17시 이후 손님 비중이 작아 더 일찍 닫아도 비교 의미가 거의 없다.
export const LAST_ORDER_TIMES = ['18:30', '18:35', '18:40', '18:45', '18:50', '18:55', '19:00']
// 07~19시를 서울시 상권 자료 구간에 맞춘 네 칸. 비중은 을지로입구 커피 상권 시간대별 카드결제 건수 비율의
// 분기별 중앙값(2024Q1~2026Q2)이며, 표시용이다(실제 나누기는 엔진이 한다).
export const SLOT_KEYS = ['07:00-11:00', '11:00-14:00', '14:00-17:00', '17:00-19:00']
export const SLOT_SHARES = [32.82, 49.68, 14.81, 2.68]
export const slotLabel = (slot: string) => slot.replaceAll(':00', '').replace('-', '~') + '시'
/** 하루 주문을 시간대 비중대로 나눈 표시용 건수(합계가 하루 주문과 같게 반올림). */
export function splitOrders(total: number) {
  const sum = SLOT_SHARES.reduce((a, b) => a + b, 0)
  const exact = SLOT_SHARES.map((share) => (total * share) / sum)
  const rounded = exact.map(Math.floor)
  let rest = total - rounded.reduce((a, b) => a + b, 0)
  for (const { i } of exact.map((v, i) => ({ i, f: v - rounded[i] })).sort((a, b) => b.f - a.f)) {
    if (rest-- <= 0) break
    rounded[i]++
  }
  return rounded
}
/** 화면 칸 값. 숫자 칸은 글자로 둔다(비우면 0이 남아 "0200"처럼 보이는 문제를 막는다). */
export type OperationFormValues = {
  dailyOrders: string
  /** '': 정하지 않음(계산할 때 기본 18:45) */
  lastOrderTime: string
  /** null: 대화로 채우는 중이라 아직 모름(폼에서 고르게 한다) */
  isOwnerWorking: boolean | null
  hourlyWage: string
  menuIds: string[]
  weights: Record<string, string>
  orderSec: string
  handoffSec: string
}

const percentWeights = (ids: string[]) =>
  rebalance(ids, Object.fromEntries(ids.map((id) => [id, (MENUS.find((m) => m.menu_id === id)?.sales_weight ?? 0) * 100])))

export const DEFAULT_FORM: OperationFormValues = {
  dailyOrders: '150',
  lastOrderTime: '',
  isOwnerWorking: true,
  hourlyWage: String(minimumWage() ?? 10_320),
  menuIds: [...DEFAULT_MENU_IDS],
  weights: percentWeights(DEFAULT_MENU_IDS),
  orderSec: '60',
  handoffSec: '30',
}

export const digitsOnly = (text: string) => text.replace(/\D/g, '').replace(/^0+(?=\d)/, '')

/** 고른 메뉴 비중을 합계 100으로 다시 나눈다. keep에 든 메뉴는 그대로 두고 나머지를 원래 비율대로 맞춘다. */
export function rebalance(ids: string[], current: Record<string, number>, keep: Record<string, number> = {}) {
  const free = ids.filter((id) => !(id in keep))
  const target = 100 - Object.values(keep).reduce((a, b) => a + b, 0)
  const base = free.map((id) => Math.max(0, current[id] ?? 0))
  const baseSum = base.reduce((a, b) => a + b, 0)
  const exact = free.map((_, i) => (baseSum > 0 ? base[i] / baseSum : 1 / free.length) * target)
  const rounded = exact.map(Math.floor)
  let rest = target - rounded.reduce((a, b) => a + b, 0)
  for (const { i } of exact.map((v, i) => ({ i, f: v - rounded[i] })).sort((a, b) => b.f - a.f)) {
    if (rest-- <= 0) break
    rounded[i]++
  }
  const next: Record<string, string> = Object.fromEntries(Object.entries(keep).map(([id, v]) => [id, String(v)]))
  free.forEach((id, i) => {
    next[id] = String(rounded[i])
  })
  return next
}

/** 화면 표의 시간대별 예상 주문(하루 주문을 상권 비중대로 나눈 값). */
export const slotCounts = (form: OperationFormValues) => splitOrders(Number(form.dailyOrders) || 0)

/** 시급 칸 안내. 최저시급 미만이면 저장 버튼을 막는다. */
export function wageProblem(form: OperationFormValues): string | null {
  if (!/^\d+$/.test(form.hourlyWage) || Number(form.hourlyWage) < 1) return '직원 시급을 적어 주세요.'
  const wage = Number(form.hourlyWage)
  if (wage > 1_000_000) return '직원 시급을 다시 확인해 주세요.'
  const year = new Date().getFullYear()
  const minimum = minimumWage(year)
  if (minimum === null) return `${year}년 최저시급 기준이 아직 없어요.`
  if (wage < minimum) return `${year}년 최저시급(${minimum.toLocaleString('ko-KR')}원)보다 낮아요. ${minimum.toLocaleString('ko-KR')}원 이상으로 적어 주세요.`
  return null
}

/** 잘못된 칸 안내. 비어 있으면 저장할 수 있다. */
export function problemsOf(form: OperationFormValues): string[] {
  const problems: string[] = []
  const orders = Number(form.dailyOrders)
  if (!/^\d+$/.test(form.dailyOrders) || orders < 1) problems.push('하루 주문 건수를 적어 주세요.')
  else if (orders > MAX_DAILY_ORDERS) problems.push(`하루 주문은 ${MAX_DAILY_ORDERS}건까지 계산할 수 있어요.`)
  if (form.isOwnerWorking === null) problems.push('사장님도 일하시는지 골라 주세요.')
  const wage = wageProblem(form)
  if (wage) problems.push(wage)
  const seconds = [Number(form.orderSec), Number(form.handoffSec)]
  if (seconds.some((n) => !(n >= 1 && n <= 300))) problems.push('처리시간은 1~300초 사이로 적어 주세요.')
  const sum = form.menuIds.reduce((total, id) => total + (Number(form.weights[id]) || 0), 0)
  if (sum !== 100) problems.push(`판매 비중 합계가 100%가 되게 맞춰 주세요. (지금 ${sum}%)`)
  return problems
}

/** 폼 값(snake_case). Spring 검사 요청 본문이자 저장 입력의 operation_form. 정하지 않은 라스트 오더는 넣지 않는다. */
export function draftBody(form: OperationFormValues): JsonObject {
  const ids = [...form.menuIds].sort()
  return {
    daily_orders: Number(form.dailyOrders),
    ...(form.lastOrderTime ? { last_order_time: form.lastOrderTime } : {}),
    is_owner_working: form.isOwnerWorking === true,
    hourly_wage_krw: Number(form.hourlyWage),
    selected_menu_ids: ids,
    menu_weights: Object.fromEntries(ids.map((id) => [id, (Number(form.weights[id]) || 0) / 100])),
    order_time_sec: Number(form.orderSec),
    handoff_time_sec: Number(form.handoffSec),
  }
}

export type DraftResponse = {
  input: JsonObject
  plan_descriptions: { choice_key: string; title: string; description: string }[]
}

/** 저장할 입력: 폼 값만. */
export const formInput = (form: OperationFormValues): JsonObject => ({ [FORM_KEY]: draftBody(form) })

/** 저장 전 검사(폼과 같은 규칙을 Spring 빌더로 한 번 더 본다). 만든 근무표는 저장하지 않는다. */
export async function draftOperationInput(form: OperationFormValues): Promise<DraftResponse> {
  const response = await request<DraftResponse>('/v1/operation/input-drafts', {
    method: 'POST',
    body: JSON.stringify(draftBody(form)),
  })
  if (response.status !== 'ok' || !response.data) {
    throw new Error(response.message ?? '운영 조건을 만들지 못했어요. 입력을 확인해 주세요.')
  }
  return response.data
}

// ---------------------------------------------------------------- 저장된 입력 → 폼 값·요약
type Shift = { worker_key: string; start_time: string; end_time: string; task_code: string }
type Worker = { worker_key: string; is_owner: boolean; hourly_wage_krw: number | null }
const obj = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])

const num = (v: unknown) => (typeof v === 'number' ? v : null)

/**
 * 저장된 운영 입력에서 읽은 값. 폼 다시 열기와 입력 검토 요약에 같이 쓴다. 필수 값이 아직 없으면 null.
 * 폼 값({operation_form})을 읽고, 이 구조 전에 저장된 완성본(simulation·labor)도 읽는다.
 */
export function readOperationInput(input: JsonObject | null) {
  if (!input) return null
  if (FORM_KEY in input) {
    const form = obj(input[FORM_KEY])
    const dailyOrders = num(form.daily_orders)
    const isOwnerWorking = typeof form.is_owner_working === 'boolean' ? form.is_owner_working : null
    const hourlyWage = num(form.hourly_wage_krw)
    if (dailyOrders === null || isOwnerWorking === null || hourlyWage === null) return null
    const menuIds = list<string>(form.selected_menu_ids)
    const weights = obj(form.menu_weights)
    return {
      businessDate: typeof form.business_date === 'string' ? form.business_date : null,
      dailyOrders,
      slotOrders: splitOrders(dailyOrders),
      /** null: 정하지 않음(계산할 때 기본값) */
      chosenLastOrder: typeof form.last_order_time === 'string' ? form.last_order_time : null,
      lastOrderTime: typeof form.last_order_time === 'string' ? form.last_order_time : DEFAULT_LAST_ORDER,
      isOwnerWorking,
      hourlyWage,
      rush: PEAK,
      menuIds,
      weights: Object.fromEntries(menuIds.map((id) => [id, typeof weights[id] === 'number' ? (weights[id] as number) : null])),
      orderSec: num(form.order_time_sec) ?? 60,
      handoffSec: num(form.handoff_time_sec) ?? 30,
    }
  }
  const simulation = obj(input.simulation)
  const scenario = obj(simulation.scenario)
  const labor = obj(input.labor)
  const workers = list<Worker>(labor.workers)
  const plans = list<{ choice_key: string; shifts: Shift[] }>(labor.plans)
  const current = plans.find((p) => p.choice_key === 'CURRENT')
  const dailyOrders = typeof scenario.daily_orders === 'number' ? scenario.daily_orders : null
  if (dailyOrders === null || !current) return null
  const lead = current.shifts[0]?.worker_key
  const wage = workers.find((w) => !w.is_owner && typeof w.hourly_wage_krw === 'number')?.hourly_wage_krw ?? null
  const menuIds = list<string>(simulation.selected_menu_ids)
  const weights = obj(simulation.menu_weights)
  const rushWindow = list<{ start_time: string; end_time: string }>(labor.avoid_break_windows)[0]
  return {
    businessDate: typeof input.business_date === 'string' ? input.business_date : null,
    dailyOrders,
    slotOrders: splitOrders(dailyOrders),
    chosenLastOrder: typeof scenario.last_order_time === 'string' ? scenario.last_order_time : null,
    lastOrderTime: typeof scenario.last_order_time === 'string' ? scenario.last_order_time : DEFAULT_LAST_ORDER,
    isOwnerWorking: workers.some((w) => w.is_owner && w.worker_key === lead),
    hourlyWage: wage,
    rush: rushWindow ? { start: rushWindow.start_time, end: rushWindow.end_time } : PEAK,
    menuIds,
    weights: Object.fromEntries(menuIds.map((id) => [id, typeof weights[id] === 'number' ? (weights[id] as number) : null])),
    orderSec: typeof simulation.order_time_sec === 'number' ? simulation.order_time_sec : 60,
    handoffSec: typeof simulation.handoff_time_sec === 'number' ? simulation.handoff_time_sec : 30,
  }
}

/** 필수 값(하루 주문·사장님 근무·시급)이 아직 다 없는 폼 입력의 값. 다 있으면 null. 계산은 다 채운 뒤에만 한다. */
export type OperationDraft = {
  dailyOrders: number | null
  isOwnerWorking: boolean | null
  hourlyWage: number | null
}
export function readOperationDraft(input: JsonObject | null): OperationDraft | null {
  if (!input || !(FORM_KEY in input) || readOperationInput(input)) return null
  const form = obj(input[FORM_KEY])
  return {
    dailyOrders: num(form.daily_orders),
    isOwnerWorking: typeof form.is_owner_working === 'boolean' ? form.is_owner_working : null,
    hourlyWage: num(form.hourly_wage_krw),
  }
}
/** 아직 채우는 중인 입력인지. 시연 업무처럼 화면에 입력이 없는(서버에만 있는) 경우는 작성 중으로 보지 않는다. */
export const isOperationDraft = (input: JsonObject | null) => readOperationDraft(input) !== null

export function formFromInput(input: JsonObject | null): OperationFormValues {
  const saved = readOperationInput(input)
  if (!saved) {
    // 대화로 채우는 중이면 말한 값만 넣고, 아직 모르는 필수 칸(주문·사장님 근무·시급)은 비워 둔다.
    const draft = readOperationDraft(input)
    return draft
      ? {
          ...DEFAULT_FORM,
          dailyOrders: draft.dailyOrders !== null ? String(draft.dailyOrders) : '',
          isOwnerWorking: draft.isOwnerWorking,
          hourlyWage: draft.hourlyWage !== null ? String(draft.hourlyWage) : '',
        }
      : DEFAULT_FORM
  }
  // 폼은 기본 5종 고정. 저장된 메뉴가 같으면 비중을 되살리고, 다르면 기본 비중을 쓴다.
  const menuIds = DEFAULT_FORM.menuIds
  const sameMenus = [...saved.menuIds].sort().join() === [...menuIds].sort().join()
  const hasWeights = sameMenus && Object.values(saved.weights).every((w) => typeof w === 'number')
  return {
    dailyOrders: String(saved.dailyOrders),
    lastOrderTime: saved.chosenLastOrder ?? '',
    isOwnerWorking: saved.isOwnerWorking,
    hourlyWage: saved.hourlyWage != null ? String(saved.hourlyWage) : DEFAULT_FORM.hourlyWage,
    menuIds,
    weights: hasWeights
      ? Object.fromEntries(menuIds.map((id) => [id, String(Math.round((saved.weights[id] ?? 0) * 100))]))
      : percentWeights(menuIds),
    orderSec: String(saved.orderSec),
    handoffSec: String(saved.handoffSec),
  }
}
