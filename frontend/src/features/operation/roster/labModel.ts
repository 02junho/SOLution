import { DEFAULT_FORM, wageFloor } from '../workspace/operationInput'
import type { Equipment, OperationFormValues, StoreData } from '../workspace/operationInput'
import { sourceOf, typeLabel, WEEKDAY_LABEL } from '../workspace/storeFile'
import type { DayBasis, StoreImport, StorePlan } from '../workspace/storeFile'

/** 계산을 막는 문제(나머지 안내는 확인 카드에 보이기만 한다). */
export function blocking(plan: StorePlan): string[] {
  return plan.problems.filter((p) => !p.includes('자동으로 못 맞췄어요'))
}

/** 확인한 가게 데이터 → 저장할 폼 값. 정리한 숫자와 근거만 담고 원본 줄은 담지 않는다. */
export function formFromPlan(
  imp: StoreImport,
  plan: StorePlan,
  people: { isOwnerWorking: boolean; hourlyWage: number | null },
  equipment?: Equipment,
  /** 유형별 제조 시간(초)을 고친 것. 계산에 쓰는 유형만 넣는다. */
  manufacture: Record<string, number> = {},
): OperationFormValues {
  const times = Object.fromEntries(Object.entries(manufacture).filter(([id]) => plan.menuCups && id in plan.menuCups))
  const store: StoreData = {
    ...(plan.ordersBySlot ? { orders_by_slot: plan.ordersBySlot } : {}),
    ...(plan.menuCups ? { menu_cups: plan.menuCups } : {}),
    ...(Object.keys(times).length ? { manufacture_sec_by_menu: times } : {}),
    ...(plan.ordersBySlot && plan.peak ? { peak_start_time: plan.peak.start, peak_end_time: plan.peak.end } : {}),
    store_source: sourceOf(imp, plan),
  }
  return {
    ...DEFAULT_FORM,
    store,
    dailyOrders: String(plan.dailyOrders),
    isOwnerWorking: people.isOwnerWorking,
    hourlyWage: String(people.hourlyWage ?? wageFloor()),
    ...(equipment && Object.keys(equipment).length ? { equipment } : {}),
  }
}

/** 바쁜 시간 고르기: 영업시간 안의 1시간 경계. */
export function hourEdges(open: string | null, close: string | null): string[] {
  if (!open || !close) return []
  const out: string[] = []
  for (let h = Number(open.slice(0, 2)); h <= Number(close.slice(0, 2)); h++) out.push(`${String(h).padStart(2, '0')}:00`)
  return out
}

/** 사장님이 화면에서 고친 것(확인 메시지의 "바꾼 것"). 기본값과 같으면 안 고친 것으로 본다. */
export type LabEdits = {
  basis: DayBasis
  peakEdited: boolean
  mapping: Record<string, string | null>
  cardSharePercent: number
  makeSec: Record<string, number>
  isOwnerWorking: boolean
  hourlyWage: number
  minimumWage: number
  espressoMachines: number
  blenders: number
  targetWaitSec: number
  defaultTargetWaitSec: number
}
export type CheckMessage = {
  summary: string
  /** 대분류별로 우리가 채운 것(확인 부탁). 빈 분류는 뺀다. */
  check: { area: string; items: string[] }[]
  changed: string[]
}

/**
 * 데이터를 받아 채운 뒤 보내는 확인 메시지. 문구는 코드가 값으로 만든다(무엇을 채웠고 어디를 보면 되는지).
 * 대분류: 영업시간·손님 / 메뉴 / 사람·설비.
 */
export function checkMessage(imp: StoreImport, plan: StorePlan, e: LabEdits): CheckMessage {
  const period = plan.period ? `${plan.period.from}~${plan.period.to} ${plan.days}일치` : '날짜 없는 합계'
  const hours = plan.open ? `영업 ${plan.open}~${plan.close}` : '영업시간 기본(07~19시)'
  const peak = plan.peak ? `바쁜 시간 ${plan.peak.start}~${plan.peak.end}` : '바쁜 시간 기본(11~14시)'
  const summary = `${imp.fileName} ${period}로 하루 ${plan.dailyOrders}잔, ${hours}, ${peak}을 정리했어요.`

  const hoursItems: string[] = []
  if (plan.open) hoursItems.push(`영업시간 ${plan.open}~${plan.close}: 결제가 꾸준히 있는 시간으로 정했어요.`)
  if (plan.peak && !e.peakEdited) hoursItems.push(`바쁜 시간 ${plan.peak.start}~${plan.peak.end}: 주문이 가장 몰리는 시간으로 정했어요.`)
  hoursItems.push(...plan.notes.filter((n) => n.area === 'HOURS').map((n) => n.text))
  const menuItems = plan.notes.filter((n) => n.area === 'MENU').map((n) => n.text)
  const dropped = plan.menus.filter((m) => m.how === 'FOOD' && !m.chosen)
  if (dropped.length) menuItems.unshift(`음료가 아니라서 뺀 메뉴 ${dropped.length}개: ${dropped.map((m) => m.name).join(', ')}`)
  const peopleItems: string[] = []
  if (e.isOwnerWorking) peopleItems.push('사장님도 같이 일한다고 봤어요.')
  if (e.hourlyWage === e.minimumWage) peopleItems.push(`직원 시급은 올해 최저시급(${e.minimumWage.toLocaleString('ko-KR')}원)으로 넣었어요.`)
  if (e.espressoMachines === 1 && e.blenders === 1) peopleItems.push('에스프레소 머신·블렌더는 1대씩으로 봤어요.')
  if (e.targetWaitSec === e.defaultTargetWaitSec)
    peopleItems.push(`목표 대기는 주문 후 ${e.defaultTargetWaitSec / 60}분 안에 10명 중 9명이 받는 것으로 잡았어요.`)
  const check = [
    { area: '영업시간·손님', items: hoursItems },
    { area: '메뉴', items: menuItems },
    { area: '사람·설비', items: peopleItems },
  ].filter((c) => c.items.length)

  const changed: string[] = []
  if (e.basis !== 'AVERAGE') changed.push(`계산할 하루를 ${WEEKDAY_LABEL[e.basis]}요일 평균으로 바꿨어요.`)
  if (e.peakEdited && plan.peak) changed.push(`바쁜 시간을 ${plan.peak.start}~${plan.peak.end}로 바꿨어요.`)
  for (const [name, id] of Object.entries(e.mapping)) changed.push(`${name}: ${id ? typeLabel(id) : '빼고 계산'}으로 바꿨어요.`)
  if (e.cardSharePercent !== 100) changed.push(`파일에 담긴 결제를 전체의 ${e.cardSharePercent}%로 보고 주문 수를 늘렸어요.`)
  for (const [id, sec] of Object.entries(e.makeSec)) changed.push(`${typeLabel(id)} 제조 시간을 ${sec}초로 바꿨어요.`)
  if (!e.isOwnerWorking) changed.push('사장님은 근무하지 않는 것으로 바꿨어요.')
  if (e.hourlyWage !== e.minimumWage) changed.push(`직원 시급을 ${e.hourlyWage.toLocaleString('ko-KR')}원으로 바꿨어요.`)
  if (e.espressoMachines !== 1) changed.push(`에스프레소 머신을 ${e.espressoMachines}대로 바꿨어요.`)
  if (e.blenders !== 1) changed.push(`블렌더를 ${e.blenders}대로 바꿨어요.`)
  if (e.targetWaitSec !== e.defaultTargetWaitSec) changed.push(`목표 대기를 ${e.targetWaitSec / 60}분으로 바꿨어요.`)
  return { summary, check, changed }
}
