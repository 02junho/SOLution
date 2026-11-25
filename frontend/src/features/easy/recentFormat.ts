import { OPTION_NAME } from '../operation/easy/rosterNames.ts'
// 최근 업무·저장한 계획 표시 형식

/** "[쉬운 화면] 점심 인원 배치" → "점심 인원 배치" */
export const cleanTitle = (title: string | null | undefined) => (title ?? '').replace(/^\[[^\]]+\]\s*/, '').trim() || '이름 없는 업무'

/** 오늘이면 "오늘 15:57", 아니면 "11월 18일" */
export function when(iso: string, now = new Date()) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const sameDay = date.toDateString() === now.toDateString()
  return sameDay
    ? `오늘 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
    : `${date.getMonth() + 1}월 ${date.getDate()}일`
}


export const FEATURE: Record<string, string> = { purchase: '장보기', operation: '점심 인원' }

/** 목록 꼬리표. 운영 중 추천 근무표(2번: 제목에 "근무표"가 있거나 근무표 안을 저장한 계획)는 "근무표"로 나눠 보인다. */
export function featureTag(feature: string, from: { title?: string | null; choiceKey?: string | null } = {}): string {
  if (feature === 'operation' && ((from.title ?? '').includes('근무표') || (from.choiceKey != null && from.choiceKey in OPTION_NAME))) return '근무표'
  return FEATURE[feature] ?? feature
}
export const STEP: Record<string, string> = { input: '입력 중', review: '조건 확인 전', running: '계산 중', result: '결과 나옴', saved: '저장함' }
export const CHOICE: Record<string, string> = {
  // 결과 화면(views.tsx)의 이름과 같게: 매입 CHOICE_NAME, 운영 PLAN_TITLE
  purchase_1: '가장 싸게', purchase_2: '한 곳에서 한 번에',
  CURRENT: '지금 그대로', ALT_A: '바쁠 때 서로 돕기', ALT_C: '점심에 한 명 더',
  // 점심 인원 추천 근무표(운영 2번): 근무표 화면과 같은 이름
  ...OPTION_NAME,
}

/** 업무 조건 한 줄 요약. 제목이 같은 업무("점심 인원 배치" 여러 개)를 목록에서 구분하게 한다. */
export function inputSummary(feature: string, input: Record<string, unknown> | null | undefined): string {
  if (!input) return ''
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  if (feature === 'purchase') {
    const parts: string[] = []
    const budget = num(input.budget_krw)
    const deliveries = num(input.max_delivery_count)
    const suppliers = Array.isArray(input.suppliers) ? input.suppliers.length : 0
    parts.push(budget === null ? '예산 안 정함' : `예산 ${budget.toLocaleString('ko-KR')}원`)
    if (deliveries !== null) parts.push(`배송 ${deliveries}번까지`)
    if (suppliers) parts.push(`거래처 ${suppliers}곳`)
    return parts.join(' · ')
  }
  if (feature === 'operation') {
    const form = input.operation_form
    if (!form || typeof form !== 'object') return '자세한 화면에서 만든 조건'
    const f = form as Record<string, unknown>
    const orders = num(f.daily_orders)
    const day = orders === null ? '' : orders === 150 ? '보통 날(150건)' : orders === 276 ? '바쁜 날(276건)' : `주문 ${orders}건`
    const owner = f.is_owner_working === true ? '사장님 같이 일함' : f.is_owner_working === false ? '직원만' : ''
    // 추천 근무표(2번)는 같은 가게로 여러 번 계산하니 바꾼 조건(목표 대기·시급)도 보여 구분한다. 기본값이면 칸이 없다.
    const wait = num(f.target_wait_sec)
    const wage = num(f.hourly_wage_krw)
    const extra = [wait ? `목표 대기 ${Math.round(wait / 60)}분` : '', wage && f.orders_by_slot ? `시급 ${wage.toLocaleString('ko-KR')}원` : '']
    return [day, owner, ...extra].filter(Boolean).join(' · ')
  }
  return ''
}

/** 저장한 근무표의 불변 계산 요청을 요약한다. 현재 업무 조건은 사용하지 않는다. */
export function rosterPlanSummary(request: unknown): string {
  const obj = (v: unknown): Record<string, unknown> | null =>
    v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v) ? v : null
  const days = obj(request)?.days
  if (!Array.isArray(days) || !days.length) return ''
  const forms = days.map((day) => obj(obj(day)?.operation_form))
  if (forms.some((f) => f === null)) return ''
  const orders = forms.map((f) => num(f?.daily_orders))
  const owner = forms.map((f) => f?.is_owner_working)
  // equipmentBody omits the default target (300 sec); stored requests preserve that omission.
  const waits = forms.map((f) => f?.target_wait_sec == null ? 300 : num(f.target_wait_sec))
  const wages = forms.map((f) => num(f?.hourly_wage_krw))
  const parts: string[] = []
  if (orders.every((v): v is number => v !== null)) {
    const avg = Math.round(orders.reduce((sum, n) => sum + n, 0) / orders.length)
    parts.push(`${days.length > 1 ? '일평균 주문' : '주문'} ${avg}건`)
  }
  if (owner.includes(true)) parts.push('사장님 같이 일함')
  else if (owner.every((v) => v === false)) parts.push('직원만')
  if (waits.every((v): v is number => v !== null) && waits.every((v) => v === waits[0])) parts.push(`목표 대기 ${waits[0] / 60}분`)
  if (wages.every((v): v is number => v !== null) && wages.every((v) => v === wages[0])) parts.push(`시급 ${wages[0].toLocaleString('ko-KR')}원`)
  return parts.join(' · ')
}
