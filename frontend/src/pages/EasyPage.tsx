// 기본 화면: 시니어 사장님용 쉬운 화면(주소에 mode가 없거나 ?mode=easy). 예전 업무 화면은 ?mode=classic.
// 멘토링(11.20): 처음부터 대화로 시작하고, 매입·운영을 고르지 않아도 말에 맞춰 바로 진행.
// 강사님·멘토님: 운영은 "시뮬레이션해 보고 배치표를 받는다"가 결과로 보이게.
// 하던 일 이어하기·저장한 계획도 원래 업무 화면으로 넘기지 않고 이 화면 안(#/work, #/plans)에서 연다.
// 근거: 시니어 사장님 화면 간소화 레퍼런스 조사(결론을 위로, 근거는 한 단계 아래, 이미 아는 값은 확인만,
// 행동형 버튼 문구, 확정 전 요약 확인).
import { useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { loadOperationResult, runOperation } from '../api/operationApi'
import { workflowApi } from '../api/workflowApi'
import { Modal } from '../components/common/Ui'
import { backOf } from '../features/easy/back'
import type { BackAction } from '../features/easy/back'
import { parseHash, routeHash } from '../features/easy/hashRoute'
import type { EasyRoute } from '../features/easy/hashRoute'
import { PlanList, SessionList } from '../features/easy/Lists'
import { OPERATION_FORM, PURCHASE_INPUT } from '../features/easy/practiceStore'
import Recent from '../features/easy/Recent'
import { CHOICE, FEATURE, cleanTitle, when } from '../features/easy/recentFormat'
import { guessFeature } from '../features/easy/route'
import type { EasyFeature } from '../features/easy/route'
import { currentStep, markTourSeen, TOUR_TOTAL, tourSeen } from '../features/easy/tour'
import TourOverlay from '../features/easy/TourOverlay'
import { Card, OperationView, Pick, PurchaseView } from '../features/easy/views'
import type { Prepared } from '../features/easy/views'
import type { OperationResult } from '../features/operation/types'
import { won } from '../features/operation/workspace/format'
import type { OperationPlan } from '../types/api'
import type { JsonObject, PurchaseResult } from '../types/workflow'
import '../features/easy/easy.css'

type Bubble = { role: 'owner' | 'agent'; text: string }
type Phase = 'start' | 'ask' | 'confirm' | 'running' | 'result' | 'error' | 'loading'
/** 이어서 하는 업무: 어느 업무의 몇 번째 조건까지 저장했고, 그때 값이 무엇이었는지 */
type Resume = { sessionId: number; versionId: number | null; versionNo: number; confirmed: boolean; values: string }
/** 이어서 열거나 저장한 계획을 볼 때 화면 위에 보여 줄 업무 이름 */
type Context = { kind: 'session' | 'plan'; feature: EasyFeature; title: string; sessionId: number; sessionGone?: boolean }
/** 고치기를 열 때의 값. "고친 것 되돌리기"로 돌아간다. */
type Snapshot = { budget: number | null; deliveries: number | null; dailyOrders: number; ownerWorking: boolean; wage: number; lastOrder: number }

// 첫 화면의 기능 카드 두 개. 누르면 예시 말(message)을 보낸 것처럼 그 기능을 시작한다.
const STARTERS = [
  { feature: 'purchase', title: '장보기', desc: '이번 주 무엇을 얼마나, 어느 거래처에서 살지', message: '이번 주 장보기 계획 세워 줘', result: '구매안과 거래처별 주문 문구' },
  { feature: 'operation', title: '점심 인원', desc: '바쁜 점심에 몇 명이 일하면 덜 기다릴지', message: '점심에 알바 한 명 더 쓰면 어때?', result: '추천 배치표' },
]

// 기능 카드 아이콘(선 그림). 장보기는 장바구니, 점심 인원은 사람 둘.
function StarterIcon({ feature }: { feature: string }) {
  return feature === 'purchase' ? (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 4h2l2.4 11.2a1 1 0 0 0 1 .8h8.7a1 1 0 0 0 1-.8L20 8H6.2" /><circle cx="9.5" cy="19.5" r="1.3" /><circle cx="17" cy="19.5" r="1.3" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5c0-3.2 2.5-5.5 5.5-5.5s5.5 2.3 5.5 5.5" /><circle cx="17" cy="9" r="2.6" /><path d="M15.8 14.2c2.6.2 4.7 2.3 4.7 5.3" />
    </svg>
  )
}
const STEPS = ['말하기', '조건 확인', '계산', '결과']
const NEW_OPERATION: JsonObject = { operation_form: { ...OPERATION_FORM } }
// 라스트 오더는 분(0시부터)으로 다룬다. 서버는 "18:45" 모양으로 받고, 비우면 18:45를 쓴다(18:30~19:00).
const DEFAULT_LAST_ORDER = 18 * 60 + 45
const toMinutes = (value: unknown) => {
  const match = typeof value === 'string' ? /^(\d{1,2}):(\d{2})$/.exec(value) : null
  return match ? Number(match[1]) * 60 + Number(match[2]) : null
}
const toHHMM = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
const lastOrderLabel = (minutes: number) => `오후 ${Math.floor(minutes / 60) - 12}시${minutes % 60 ? ` ${minutes % 60}분` : ''}`
const LARGE_KEY = 'solution.easy.large'

const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const asObject = (value: unknown): JsonObject | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : null)
const withCurrent = (options: number[], current: number | null) =>
  [...new Set(current === null ? options : [...options, current])].sort((a, b) => a - b)

export default function EasyPage() {
  const [route, setRoute] = useState<EasyRoute>(() => parseHash(window.location.hash))
  // 글자 크게: 다음에 들어와도 그대로(브라우저 저장소가 막혀 있으면 보통 글자로)
  const [large, setLarge] = useState(() => { try { return window.localStorage.getItem(LARGE_KEY) === '1' } catch { return false } })
  const toggleLarge = () => {
    const next = !large
    setLarge(next)
    try { window.localStorage.setItem(LARGE_KEY, next ? '1' : '0') } catch { /* 기억하지 못해도 화면은 바뀐다 */ }
  }
  const [helpOpen, setHelpOpen] = useState(false)
  const [guideOpen, setGuideOpen] = useState(false)
  // 따라 하며 배우기: 켜짐 여부, 결과 화면 안에서 몇 번째 안내인지, 첫 방문 권유 카드
  const [tourOn, setTourOn] = useState(false)
  const [tourResultIndex, setTourResultIndex] = useState(0)
  const [tourOffer, setTourOffer] = useState(() => !tourSeen())
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const [text, setText] = useState('')
  const [phase, setPhase] = useState<Phase>(() => {
    const first = parseHash(window.location.hash)
    return first.kind === 'session' || first.kind === 'plan' ? 'loading' : 'start'
  })
  const [feature, setFeature] = useState<EasyFeature | null>(null)
  const [error, setError] = useState('')
  // 조건 때문에 안 되는지(input), 서버·연결 문제인지(server). 서버 문제면 조건은 그대로 두고 다시 시도만 하면 된다.
  const [errorKind, setErrorKind] = useState<'input' | 'server'>('server')
  const [editing, setEditing] = useState(false)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  // 계산에 쓰는 조건. 새 업무는 연습 가게 값, 이어서 하는 업무는 그 업무에 저장된 값에서 시작한다.
  const [base, setBase] = useState<JsonObject>(PURCHASE_INPUT)
  const [budget, setBudget] = useState<number | null>(asNumber(PURCHASE_INPUT.budget_krw))
  const [deliveries, setDeliveries] = useState<number | null>(asNumber(PURCHASE_INPUT.max_delivery_count))
  const [dailyOrders, setDailyOrders] = useState(OPERATION_FORM.daily_orders)
  const [ownerWorking, setOwnerWorking] = useState(OPERATION_FORM.is_owner_working)
  const [wage, setWage] = useState(OPERATION_FORM.hourly_wage_krw)
  const [lastOrder, setLastOrder] = useState(DEFAULT_LAST_ORDER)
  // 이 화면에서 새로 시작한 업무인지(메뉴 밑줄을 "홈"에 두려고). 목록에서 연 업무면 false.
  const [startedHere, setStartedHere] = useState(false)
  // 이어서 계산할 업무·입력 버전. 화면에 그리지 않고, 앞선 준비 요청이 끝난 직후의 최신 값을 읽어야 해서 ref로 둔다.
  const resumeRef = useRef<Resume | null>(null)
  // 같은 화면 안의 "업무 만들기·조건 저장" 준비 요청을 한 줄로 세운다. 다시 계산하면 앞 요청이 끝난 뒤 그 결과를 이어받는다.
  const prepRef = useRef<Promise<unknown>>(Promise.resolve())
  // 화면 번호(그리기용). 저장 버튼을 누른 화면과 저장이 끝났을 때의 화면이 같은지 비교한다.
  const [screenNo, setScreenNo] = useState(0)
  const [context, setContext] = useState<Context | null>(null)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [purchase, setPurchase] = useState<PurchaseResult | null>(null)
  const [operation, setOperation] = useState<OperationResult | null>(null)
  const [saved, setSaved] = useState('')
  // 이 화면에서 방금 저장한 안(choice_key). 다른 안으로 바꿔 보면 "저장했어요"를 숨기고 그 안도 따로 저장할 수 있게 한다.
  const [savedFor, setSavedFor] = useState<string | null>(null)
  const [savedChoice, setSavedChoice] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const resultRef = useRef<HTMLDivElement>(null)
  // 화면을 옮긴 뒤 늦게 도착한 응답이 새 화면을 덮지 않게 한다.
  const tokenRef = useRef(0)
  // 다른 화면으로 옮길 때만 바뀌는 표시. "계산 멈추기"는 tokenRef만 바꿔 결과는 버리지만,
  // 서버에 이미 저장된 업무·입력 버전은 같은 화면이면 기록해 두어야 다시 계산할 때 이어진다.
  const screenRef = useRef(0)
  // 지금 보이는 결과의 result_id. 늦게 끝난 저장 응답이 다른 결과에 "저장했어요"를 붙이지 않게 비교한다.
  const shownResultRef = useRef<number | null>(null)

  // 대화 중에는 마지막 말이 보이게, 결과가 나오면 추천 문장부터 보이게(스크롤하지 않아도 결론이 보이도록).
  useEffect(() => {
    if (phase === 'result') resultRef.current?.scrollIntoView({ block: 'start' })
    else endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [bubbles, phase])

  function startTour() {
    restart()
    setGuideOpen(false)
    setTourOffer(false)
    setTourOn(true)
  }
  function endTour() {
    setTourOn(false)
    setTourOffer(false)
    markTourSeen()
  }

  function openEdit() {
    setSnapshot({ budget, deliveries, dailyOrders, ownerWorking, wage, lastOrder })
    setEditing(true)
  }
  function cancelEdit() {
    if (snapshot) {
      setBudget(snapshot.budget); setDeliveries(snapshot.deliveries)
      setDailyOrders(snapshot.dailyOrders); setOwnerWorking(snapshot.ownerWorking)
      setWage(snapshot.wage); setLastOrder(snapshot.lastOrder)
    }
    setSnapshot(null)
    setEditing(false)
  }

  /** 이전·취소. 갈 곳은 back.ts 규칙이 정한다. */
  function doBack(action: BackAction) {
    if (action.kind === 'route') { go(action.route); return }
    if (action.phase === 'start') { restart(); return }
    if (action.cancelRun) {
      // 늦게 도착한 계산 결과는 버린다. 서버에는 결과가 남을 수 있지만 저장하기 전이라 바뀌는 건 없다.
      tokenRef.current += 1
      say('agent', '계산을 멈췄어요. 조건을 다시 볼 수 있어요.')
    }
    setEditing(false); setSnapshot(null); setError('')
    setPhase(action.phase)
  }

  const say = (role: Bubble['role'], value: string) => setBubbles((list) => [...list, { role, text: value }])

  function reset() {
    setBubbles([]); setText(''); setPhase('start'); setFeature(null); setError(''); setEditing(false); setSnapshot(null)
    setBase(PURCHASE_INPUT); setBudget(asNumber(PURCHASE_INPUT.budget_krw)); setDeliveries(asNumber(PURCHASE_INPUT.max_delivery_count))
    setDailyOrders(OPERATION_FORM.daily_orders); setOwnerWorking(OPERATION_FORM.is_owner_working)
    setWage(OPERATION_FORM.hourly_wage_krw); setLastOrder(DEFAULT_LAST_ORDER)
    resumeRef.current = null; setContext(null); setPrepared(null); setPurchase(null); setOperation(null); setSaved(''); setSavedFor(null); setSavedChoice(null)
    shownResultRef.current = null
  }

  /** 저장이 끝났을 때: 저장을 누른 화면(screen)에서 같은 결과가 아직 보이고 있을 때만 "저장했어요"로 바꾼다.
   *  같은 결과를 목록에서 다시 열었으면 화면 번호가 달라 늦은 응답을 반영하지 않는다. */
  function markSaved(resultId: number, text: string, choiceKey: string, screen: number) {
    if (screen !== screenRef.current || shownResultRef.current !== resultId) return
    setSaved(text); setSavedFor(choiceKey)
  }

  function open(next: EasyRoute) {
    tokenRef.current += 1
    screenRef.current += 1
    setScreenNo(screenRef.current)
    prepRef.current = Promise.resolve()
    const token = tokenRef.current
    reset()
    setRoute(next)
    setStartedHere(false)
    window.scrollTo({ top: 0 })
    if (next.kind === 'session') { setPhase('loading'); void loadSession(next.id, token) }
    if (next.kind === 'plan') { setPhase('loading'); void loadPlan(next.id, token) }
  }

  /** 같은 주소면 바로 다시 열고, 다른 주소면 주소를 바꿔 hashchange로 연다(뒤로 가기가 되게). */
  function go(next: EasyRoute) {
    const hash = routeHash(next)
    if (window.location.hash === hash) open(next)
    else window.location.assign(hash)
  }
  const link = (next: EasyRoute) => ({
    href: routeHash(next),
    onClick: (event: MouseEvent) => { event.preventDefault(); go(next) },
  })
  const restart = () => go({ kind: 'home' })

  /** 업무에 저장된 조건으로 확인 카드를 채운다. */
  function fill(kind: EasyFeature, input: JsonObject | null) {
    const value = input ?? (kind === 'purchase' ? PURCHASE_INPUT : NEW_OPERATION)
    setBase(value)
    if (kind === 'purchase') {
      const nextBudget = asNumber(value.budget_krw)
      const nextDeliveries = asNumber(value.max_delivery_count)
      setBudget(nextBudget); setDeliveries(nextDeliveries)
      setEditing(nextBudget === null || nextDeliveries === null)
      return valuesKey(nextBudget, nextDeliveries, OPERATION_FORM.daily_orders, OPERATION_FORM.is_owner_working, OPERATION_FORM.hourly_wage_krw, DEFAULT_LAST_ORDER)
    }
    const form = asObject(value.operation_form)
    const orders = asNumber(form?.daily_orders) ?? OPERATION_FORM.daily_orders
    const owner = typeof form?.is_owner_working === 'boolean' ? form.is_owner_working : OPERATION_FORM.is_owner_working
    const nextWage = asNumber(form?.hourly_wage_krw) ?? OPERATION_FORM.hourly_wage_krw
    const nextLast = toMinutes(form?.last_order_time) ?? DEFAULT_LAST_ORDER
    setDailyOrders(orders); setOwnerWorking(owner); setWage(nextWage); setLastOrder(nextLast)
    return valuesKey(asNumber(PURCHASE_INPUT.budget_krw), asNumber(PURCHASE_INPUT.max_delivery_count), orders, owner, nextWage, nextLast)
  }

  async function loadResult(kind: EasyFeature, resultId: number): Promise<PurchaseResult | OperationResult> {
    if (kind === 'purchase') return workflowApi.result(resultId)
    const detail = await loadOperationResult(resultId, 'detail')
    if (detail.status === 'error' || !detail.data) throw new Error(detail.message || '결과를 불러오지 못했어요.')
    return detail.data
  }

  function showResult(kind: EasyFeature, result: PurchaseResult | OperationResult) {
    shownResultRef.current = result.result_id
    setPrepared({ sessionId: result.session_id, versionId: result.input_version_id, versionNo: result.version_no })
    if (kind === 'purchase') setPurchase(result as PurchaseResult)
    else setOperation(result as OperationResult)
  }

  // 하던 일 열기: 지금 조건으로 나온 결과가 있으면 결과를, 없으면 조건 확인부터.
  async function loadSession(id: number, token: number) {
    try {
      const session = await workflowApi.context(id)
      if (token !== tokenRef.current) return
      if (session.feature_type !== 'purchase' && session.feature_type !== 'operation') throw new Error('쉬운 화면에서 열 수 없는 업무예요.')
      const kind: EasyFeature = session.feature_type
      const values = fill(kind, session.current_input ?? null)
      setFeature(kind)
      setContext({ kind: 'session', feature: kind, title: cleanTitle(session.title), sessionId: id })
      resumeRef.current = { sessionId: id, versionId: session.current_version_id, versionNo: session.current_version, confirmed: session.input_confirmed, values }
      if (session.latest_result_id) {
        const result = await loadResult(kind, session.latest_result_id)
        if (token !== tokenRef.current) return
        const usable = result.is_latest_version && result.response_status === 'ok'
        if (usable) {
          showResult(kind, result)
          if (result.confirmed_choice_key) { setSavedChoice(result.confirmed_choice_key); setSaved(`저장한 업무예요 · ${CHOICE[result.confirmed_choice_key] ?? result.confirmed_choice_key}`) }
          setTourResultIndex(0)
          setPhase('result')
          return
        }
      }
      setPhase('confirm')
    } catch (cause) {
      if (token !== tokenRef.current) return
      setError(cause instanceof Error ? cause.message : '업무를 불러오지 못했어요.')
      setFeature(null) // 열다가 멈춘 것: "다시 시도"는 다시 여는 것으로
      setPhase('error')
    }
  }

  // 저장한 계획 보기: 저장할 때의 결과와 고른 안을 그대로 보여 준다.
  async function loadPlan(id: number, token: number) {
    try {
      const plan = await workflowApi.confirmation(id)
      if (token !== tokenRef.current) return
      if (plan.feature_type !== 'purchase' && plan.feature_type !== 'operation') throw new Error('쉬운 화면에서 열 수 없는 계획이에요.')
      const kind: EasyFeature = plan.feature_type
      const result = await loadResult(kind, plan.result_id)
      // 업무를 지웠어도 저장한 계획은 남는다(서버 규칙). 그때는 "이 업무 열기" 대신 지워졌다고 알려 준다.
      const sessionGone = await workflowApi.context(plan.session_id).then(() => false, () => true)
      if (token !== tokenRef.current) return
      setFeature(kind)
      setContext({ kind: 'plan', feature: kind, title: CHOICE[plan.selected_choice_key] ?? plan.selected_choice_key, sessionId: plan.session_id, sessionGone })
      showResult(kind, result)
      setSavedChoice(plan.selected_choice_key)
      setSaved(`${when(plan.confirmed_at)}에 저장한 계획이에요`)
      setPhase('result')
    } catch (cause) {
      if (token !== tokenRef.current) return
      setError(cause instanceof Error ? cause.message : '계획을 불러오지 못했어요.')
      setFeature(null) // 열다가 멈춘 것: "다시 시도"는 다시 여는 것으로
      setPhase('error')
    }
  }

  function begin(next: EasyFeature) {
    setFeature(next)
    setBase(next === 'purchase' ? PURCHASE_INPUT : NEW_OPERATION)
    setPhase('confirm')
    say('agent', next === 'purchase'
      ? '이번 주 장보기 계획을 세워 볼게요.'
      : '점심 인원 배치를 돌려 볼게요.')
  }

  function send(value: string) {
    const words = value.trim()
    if (!words) return
    say('owner', words)
    setText('')
    const guessed = guessFeature(words)
    if (guessed) begin(guessed)
    else {
      setPhase('ask')
      say('agent', '어떤 일을 도와드릴까요?')
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    send(text)
  }

  const operationForm = asObject(base.operation_form)
  const values = valuesKey(budget, deliveries, dailyOrders, ownerWorking, wage, lastOrder)

  function buildInput(kind: EasyFeature): JsonObject {
    if (kind === 'purchase') return { ...base, budget_krw: budget, max_delivery_count: deliveries }
    if (!operationForm) return base // 자세한 화면에서 만든 조건은 그대로 쓴다.
    return { ...base, operation_form: { ...operationForm, daily_orders: dailyOrders, is_owner_working: ownerWorking, hourly_wage_krw: wage, last_order_time: toHHMM(lastOrder) } }
  }

  // 조건을 새 버전으로 저장하고 입력 확인까지 마친다.
  // 저장(이벤트)은 서버에 먼저 남으므로, 확인이 실패해도 다시 시도할 때 이 새 버전부터 이어 가게 바로 기록해 둔다.
  // (옛 버전을 base로 다시 보내면 서버가 STALE로 거부한다.) 계산을 멈췄어도 같은 화면이면 기록하고, 다른 화면으로 옮겼을 때만 건너뛴다.
  async function saveInput(sessionId: number, baseVersionId: number | null, kind: EasyFeature, screen: number) {
    const response = await workflowApi.event(sessionId, { event_type: 'form', form_input: buildInput(kind), base_version_id: baseVersionId }, crypto.randomUUID())
    const data = response.data as JsonObject | null
    const versionId = Number(data?.input_version_id)
    const versionNo = Number(data?.version_no)
    if (response.status !== 'ok' || !versionId) throw new Error(response.message || '조건을 저장하지 못했어요.')
    if (screen === screenRef.current) resumeRef.current = { sessionId, versionId, versionNo, confirmed: false, values }
    await workflowApi.confirmInput(versionId, versionNo)
    return { versionId, versionNo }
  }

  // 새 업무면 만들고, 이어서 하는 업무면 그 업무 안에서. 조건이 그대로면 저장된 버전을 다시 쓴다.
  async function ready(kind: EasyFeature, screen: number): Promise<Prepared> {
    const resume = resumeRef.current
    if (!resume) {
      const created = await workflowApi.create(1, kind, 'form', kind === 'purchase' ? '[쉬운 화면] 이번 주 장보기' : '[쉬운 화면] 점심 인원 배치')
      // 조건 저장이 실패해도 다시 시도할 때 업무를 또 만들지 않게, 만든 업무를 먼저 기록해 둔다.
      if (screen === screenRef.current) resumeRef.current = { sessionId: created.session_id, versionId: null, versionNo: 0, confirmed: false, values: '' }
      return { sessionId: created.session_id, ...(await saveInput(created.session_id, null, kind, screen)) }
    }
    if (resume.versionId === null || resume.values !== values) {
      return { sessionId: resume.sessionId, ...(await saveInput(resume.sessionId, resume.versionId, kind, screen)) }
    }
    if (!resume.confirmed) await workflowApi.confirmInput(resume.versionId, resume.versionNo)
    return { sessionId: resume.sessionId, versionId: resume.versionId, versionNo: resume.versionNo }
  }

  async function calculate() {
    if (!feature) return
    const token = tokenRef.current
    setPhase('running'); setError(''); setSaved(''); setSavedFor(null); setSavedChoice(null)
    // 이전 결과를 지운다. 계산이 실패했을 때 옛 결과와 새 조건(prepared)이 짝지어 보이거나 저장되지 않게.
    setPurchase(null); setOperation(null)
    shownResultRef.current = null
    try {
      // 앞선 준비 요청(그만두기로 결과만 버린 것 포함)이 끝난 뒤에 이어서 준비한다. 앞 요청이 실패해도 이번 요청은 진행한다.
      const screen = screenRef.current
      const job = prepRef.current.catch(() => undefined).then(() => {
        // 줄에서 기다리는 사이 다른 업무를 열었으면(화면이 바뀌면) 실행하지 않는다. 열린 업무에 이전 화면 조건이 저장되지 않게.
        if (screen !== screenRef.current) throw new Error('다른 화면으로 옮겨 계산을 멈췄어요.')
        return ready(feature, screen)
      })
      prepRef.current = job
      const done = await job
      if (token !== tokenRef.current) return
      // 다시 계산하면 같은 업무 안에서 이어지게 하고, 주소도 이 업무로 바꿔 새로 고쳐도 다시 열리게 한다.
      resumeRef.current = { sessionId: done.sessionId, versionId: done.versionId, versionNo: done.versionNo, confirmed: true, values }
      setPrepared(done)
      if (route.kind !== 'session') {
        window.history.replaceState(null, '', routeHash({ kind: 'session', id: done.sessionId }))
        setRoute({ kind: 'session', id: done.sessionId })
        setStartedHere(true)
      }
      if (feature === 'purchase') {
        const response = await workflowApi.calculate(done.sessionId, done.versionId, crypto.randomUUID())
        const resultId = Number((response.data as JsonObject | null)?.result_id)
        const result = await workflowApi.result(resultId)
        if (token !== tokenRef.current) return
        if (result.response_status !== 'ok') throw new InputError(result.summary.message || '이 조건으로는 살 수 있는 조합이 없어요.')
        shownResultRef.current = result.result_id
        setPurchase(result); setOperation(null)
      } else {
        const response = await runOperation(done.sessionId, done.versionId, crypto.randomUUID())
        if (response.status === 'error' || !response.data) throw new Error(response.message || '계산을 마치지 못했어요.')
        const detail = await loadOperationResult(response.data.result_id, 'detail')
        if (detail.status === 'error' || !detail.data) throw new Error(detail.message || '결과를 불러오지 못했어요.')
        if (token !== tokenRef.current) return
        shownResultRef.current = detail.data.result_id
        setOperation(detail.data); setPurchase(null)
      }
      setTourResultIndex(0)
      setPhase('result')
    } catch (cause) {
      if (token !== tokenRef.current) return
      setError(cause instanceof Error ? cause.message : '계산을 마치지 못했어요.')
      setErrorKind(cause instanceof InputError ? 'input' : 'server')
      setPhase('error')
    }
  }

  // 주소(#) 따라 화면 열기. 처음 들어온 주소도, 뒤로 가기도 같은 길로 연다.
  useEffect(() => {
    const first = parseHash(window.location.hash)
    const token = tokenRef.current
    if (first.kind === 'session') void loadSession(first.id, token)
    if (first.kind === 'plan') void loadPlan(first.id, token)
    const onHash = () => open(parseHash(window.location.hash))
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
    // 처음 한 번만 연결한다. open·load는 상태를 읽지 않고 바꾸기만 한다.
  }, [])

  // 오류는 계산 단계에서 멈춘 것으로 보여 준다(결과 단계로 보이지 않게).
  const stepIndex = phase === 'start' || phase === 'ask' ? 0 : phase === 'confirm' ? 1 : phase === 'running' || phase === 'error' ? 2 : 3
  const onHome = route.kind === 'home'
  const inFlow = route.kind === 'home' || route.kind === 'session'
  const fresh = onHome && phase === 'start' && bubbles.length === 0
  const items = Array.isArray(base.items) ? base.items.map((item) => String(asObject(item)?.item_name ?? '')).filter(Boolean) : []
  const supplierCount = Array.isArray(base.suppliers) ? base.suppliers.length : 0
  const purchaseReady = budget !== null && deliveries !== null
  const back = backOf({ phase, route: route.kind, hasResult: Boolean(purchase || operation), resumed: context?.kind === 'session', hasFeature: Boolean(feature) })
  const nav: { label: string; route: EasyRoute; current: boolean }[] = [
    { label: '홈', route: { kind: 'home' }, current: onHome || (route.kind === 'session' && startedHere) },
    { label: '하던 일 이어하기', route: { kind: 'sessions' }, current: route.kind === 'sessions' || (route.kind === 'session' && !startedHere) },
    { label: '저장한 계획', route: { kind: 'plans' }, current: route.kind === 'plans' || route.kind === 'plan' },
  ]

  return (
    <div className={`easy${large ? ' easy-large' : ''}`}>
      {/* 기존 업무 화면과 같은 머리(로고 · 메뉴). 메뉴는 쉬운 화면에서 자주 찾을 일만 둔다. */}
      <header className="app-header easy-header">
        <a className="brand" {...link({ kind: 'home' })}>
          <span className="brand-symbol">S<span>✦</span></span>
          <span>SOL<span className="brand-light">루션</span><small>사장님 업무 도우미</small></span>
        </a>
        <nav aria-label="주 메뉴">
          {nav.map((item) => (
            <a key={item.label} {...link(item.route)} aria-current={item.current ? 'page' : undefined}>{item.label}</a>
          ))}
          <a href="#" onClick={(e) => { e.preventDefault(); setGuideOpen(true) }}>사용법</a>
        </nav>
        <div className="easy-tools">
          {!fresh && (
            <button type="button" className="easy-tools-restart" onClick={restart}>↺ 처음부터 다시</button>
          )}
          <button type="button" onClick={toggleLarge} aria-pressed={large}>{large ? '글자 보통으로' : '글자 크게'}</button>
          <button type="button" onClick={() => setHelpOpen(!helpOpen)} aria-expanded={helpOpen}>도움 받기</button>
        </div>
      </header>

      <div className="easy-layout">
      <main className="easy-main">
        {route.kind === 'sessions' && <SessionList />}
        {route.kind === 'plans' && <PlanList />}

        {/* 이전 줄: 어느 단계든 한 칸 뒤로(back.ts). 이어서 연 업무·저장한 계획이면 무엇을 보고 있는지도 같이. */}
        {back && route.kind !== 'sessions' && route.kind !== 'plans' && (
          <div className="easy-backbar">
            <button type="button" className="easy-back" onClick={() => doBack(back.action)}>← {back.label}</button>
            {context && (
              <p>
                <span className={`easy-tag ${context.feature}`}>{FEATURE[context.feature]}</span>
                <b>{context.title}</b>
              </p>
            )}
            {context?.kind === 'plan' && (context.sessionGone
              ? <span className="easy-muted">업무는 지웠어요</span>
              : <a className="easy-text-button" {...link({ kind: 'session', id: context.sessionId })}>이 업무 열기 ›</a>)}
          </div>
        )}

        {feature && inFlow && !tourOn && phase !== 'loading' && (
          <div role="progressbar" aria-valuemin={1} aria-valuemax={STEPS.length} aria-valuenow={stepIndex + 1}
            aria-valuetext={`${STEPS.length}단계 중 ${stepIndex + 1}단계, ${STEPS[stepIndex]}`}>
            <div className="easy-progress"><div style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }} /></div>
            <p className="easy-step-label">{stepIndex + 1} / {STEPS.length} · {STEPS[stepIndex]}</p>
          </div>
        )}

        {fresh && tourOffer && !tourOn && (
          <section className="easy-tour-offer" aria-label="처음 쓰는 분 안내">
            <div>
              <b>처음이세요?</b>
              <span>화면을 직접 눌러 보며 {TOUR_TOTAL}단계로 배워요. 2분이면 돼요.</span>
            </div>
            <button type="button" className="easy-primary" onClick={startTour}>따라 해 보기</button>
            <button type="button" className="easy-secondary" onClick={() => { setTourOffer(false); markTourSeen() }}>괜찮아요</button>
          </section>
        )}

        {fresh && (
          <section className="easy-hello">
            <h1>무엇을 도와드릴까요?</h1>
            <p>카페 사장님의 장보기와 점심 인원 배치를 대신 계산해 드려요.</p>
          </section>
        )}

        {inFlow && (
          <div className="easy-chat" role="log" aria-live="polite">
            {bubbles.map((bubble, i) => (
              <p key={i} className={`easy-bubble ${bubble.role}`}>{bubble.text}</p>
            ))}
          </div>
        )}

        {onHome && (phase === 'start' || phase === 'ask') && (
          <div data-tour={phase === 'start' ? 'input' : undefined}>
            {phase === 'ask' ? (
              <div className="easy-choices" data-tour="choices">
                <button type="button" className="easy-big" onClick={() => { say('owner', '이번 주 장보기 계획'); begin('purchase') }}>이번 주 장보기 계획 세우기</button>
                <button type="button" className="easy-big" onClick={() => { say('owner', '점심 인원 배치'); begin('operation') }}>점심 인원 배치 돌려 보기</button>
              </div>
            ) : null}
            <form className="easy-input" onSubmit={submit}>
              <label htmlFor="easy-text" className="easy-sr">사장님 말</label>
              <textarea id="easy-text" rows={2} value={text} placeholder="예: 점심에 줄이 너무 길어요" onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(text) } }} />
              <button type="submit" className="easy-primary" disabled={!text.trim()}>보내기</button>
            </form>
            {phase === 'start' && (
              // 대화로 시작하는 게 기본이고, 이 카드는 물어볼 수 있는 말과 받게 될 결과를 보여 주는 지름길이다.
              <section className="easy-starters-wrap" aria-label="할 수 있는 일">
                <h2>할 수 있는 일 <span>눌러서 바로 시작하거나, 위에 말로 적어도 돼요</span></h2>
                <div className="easy-starters">
                  {STARTERS.map((starter) => (
                    <button key={starter.feature} type="button" className={`easy-starter ${starter.feature}`} onClick={() => send(starter.message)}>
                      <span className="easy-starter-icon"><StarterIcon feature={starter.feature} /></span>
                      <span className="easy-starter-body">
                        <b className="easy-starter-title">{starter.title}</b>
                        <span className="easy-starter-desc">{starter.desc}</span>
                        <span className="easy-starter-say">예: “{starter.message}”</span>
                      </span>
                      <span className="easy-starter-foot">
                        <span className="easy-starter-result">결과: {starter.result}</span>
                        <span className="easy-starter-go">시작하기 →</span>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}

        {fresh && !tourOn && <Recent />}

        {phase === 'loading' && (
          <div className="easy-running" role="status">
            <span className="easy-spinner" aria-hidden />
            불러오는 중이에요
          </div>
        )}

        {inFlow && phase === 'confirm' && feature === 'purchase' && (
          <Card title="이 조건이 맞나요?" tour="confirm">
            <ul className="easy-facts">
              <li><span>계획 기간</span><b>{asNumber(base.planning_days) ?? 7}일</b></li>
              <li><span>예산</span><b>{budget === null ? '정하지 않았어요' : `${won(budget)}까지`}</b></li>
              <li><span>배송 받는 횟수</span><b>{deliveries === null ? '정하지 않았어요' : `${deliveries}번까지`}</b></li>
              <li><span>살 품목</span><b>{items.length ? items.join(' · ') : '아직 없어요'}</b></li>
              <li><span>받은 견적</span><b>{supplierCount ? `거래처 ${supplierCount}곳` : '아직 없어요'}</b></li>
            </ul>
            {editing && (
              <div className="easy-edit">
                <Pick label="예산" value={budget ?? Number.NaN} options={withCurrent([150000, 200000, 250000], budget)} format={(v) => won(v)} onPick={setBudget} />
                <Pick label="배송 받는 횟수" value={deliveries ?? Number.NaN} options={withCurrent([1, 2, 3], deliveries)} format={(v) => `${v}번까지`} onPick={setDeliveries} />
              </div>
            )}
            {!purchaseReady && <p className="easy-note">예산과 배송 받는 횟수를 골라 주세요.</p>}
            <div className={`easy-cta${editing ? ' easy-cta-static' : ''}`}>
              <button type="button" className="easy-primary" disabled={!purchaseReady} onClick={() => void calculate()}>구매안 계산하기</button>
              {editing ? (
                <>
                  <button type="button" className="easy-secondary" onClick={() => { setEditing(false); setSnapshot(null) }}>다 고쳤어요</button>
                  <button type="button" className="easy-text-button" onClick={cancelEdit}>고친 것 되돌리기</button>
                </>
              ) : <button type="button" className="easy-secondary" onClick={openEdit}>고치기</button>}
            </div>
          </Card>
        )}

        {inFlow && phase === 'confirm' && feature === 'operation' && (
          <Card title="이 조건이 맞나요?" tour="confirm">
            {operationForm ? (
              <ul className="easy-facts">
                <li><span>영업 시간</span><b>오전 7시 ~ 오후 7시</b></li>
                <li><span>하루 주문</span><b>약 {dailyOrders}건</b></li>
                <li><span>일하는 사람</span><b>{ownerWorking ? '사장님 + 직원 1명' : '직원만'}</b></li>
                <li><span>라스트 오더</span><b>{lastOrderLabel(lastOrder)}</b></li>
                <li><span>직원 시급</span><b>{won(wage)}</b></li>
              </ul>
            ) : (
              <p>자세한 화면에서 만든 조건이에요. 조건은 그대로 두고 다시 계산할 수 있어요.</p>
            )}
            {editing && operationForm && (
              <div className="easy-edit">
                <Pick label="하루 주문" value={dailyOrders} options={withCurrent([150, 276], dailyOrders)} format={(v) => (v === 150 ? '보통 날 (150건)' : v === 276 ? '바쁜 날 (276건)' : `${v}건`)} onPick={setDailyOrders} />
                <Pick label="사장님도 일하나요?" value={ownerWorking ? 1 : 0} options={[1, 0]} format={(v) => (v ? '네, 같이 일해요' : '아니요')} onPick={(v) => setOwnerWorking(v === 1)} />
                <Pick label="라스트 오더" value={lastOrder} options={withCurrent([18 * 60 + 30, DEFAULT_LAST_ORDER, 19 * 60], lastOrder)} format={lastOrderLabel} onPick={setLastOrder} />
                <Pick label="직원 시급" value={wage} options={withCurrent([10320, 11000, 12000], wage)} format={(v) => won(v)} onPick={setWage} />
              </div>
            )}
            <div className={`easy-cta${editing ? ' easy-cta-static' : ''}`}>
              <button type="button" className="easy-primary" onClick={() => void calculate()}>배치표 만들기</button>
              {operationForm && (editing ? (
                <>
                  <button type="button" className="easy-secondary" onClick={() => { setEditing(false); setSnapshot(null) }}>다 고쳤어요</button>
                  <button type="button" className="easy-text-button" onClick={cancelEdit}>고친 것 되돌리기</button>
                </>
              ) : <button type="button" className="easy-secondary" onClick={openEdit}>고치기</button>)}
            </div>
          </Card>
        )}

        {phase === 'running' && (
          <div className="easy-running" role="status">
            <span className="easy-spinner" aria-hidden />
            <span>{feature === 'operation' ? '30번 돌려 보는 중이에요' : '가장 싼 조합을 찾는 중이에요'}</span>
            {back && <button type="button" className="easy-secondary easy-running-cancel" onClick={() => doBack(back.action)}>그만두기</button>}
          </div>
        )}

        {phase === 'error' && (
          !feature ? (
            <Card title="열지 못했어요">
              <p>{error}</p>
              <div className="easy-actions">
                <button type="button" className="easy-primary" onClick={() => open(route)}>다시 시도</button>
                <button type="button" className="easy-secondary" onClick={restart}>처음으로</button>
              </div>
            </Card>
          ) : errorKind === 'input' ? (
            <Card title="이 조건으로는 계산이 안 돼요">
              <p>{error}</p>
              <div className="easy-actions">
                {inFlow && <button type="button" className="easy-primary" onClick={() => { setPhase('confirm'); openEdit() }}>조건 고쳐서 다시 하기</button>}
                <button type="button" className="easy-secondary" onClick={restart}>처음으로</button>
              </div>
            </Card>
          ) : (
            <Card title="잠깐 연결이 안 됐어요">
              <p>{error}</p>
              <p className="easy-muted">조건은 그대로예요. 잠시 뒤 "다시 시도"를 눌러 주세요.</p>
              <div className="easy-actions">
                {inFlow && <button type="button" className="easy-primary" onClick={() => void calculate()}>다시 시도</button>}
                {inFlow && <button type="button" className="easy-secondary" onClick={() => setPhase('confirm')}>조건 다시 보기</button>}
                <button type="button" className="easy-secondary" onClick={restart}>처음으로</button>
              </div>
            </Card>
          )
        )}

        <div ref={resultRef} className="easy-anchor" />
        {phase === 'result' && purchase && prepared && (
          <PurchaseView result={purchase} prepared={prepared} saved={saved} savedFor={savedFor} onSaved={(text, choiceKey) => markSaved(purchase.result_id, text, choiceKey, screenNo)} savedChoice={savedChoice} maxDeliveries={context?.kind === 'plan' ? null : deliveries} />
        )}
        {phase === 'result' && operation && prepared && (
          <OperationView result={operation} prepared={prepared} saved={saved} savedFor={savedFor} onSaved={(text, choiceKey) => markSaved(operation.result_id, text, choiceKey, screenNo)} savedChoice={savedChoice as OperationPlan | null} />
        )}
        {phase === 'result' && route.kind === 'session' && !savedChoice && (
          <p className="easy-again">
            <button type="button" className="easy-text-button" onClick={() => { setPhase('confirm'); openEdit() }}>조건 바꿔서 다시 계산하기</button>
          </p>
        )}
        <div ref={endRef} />
      </main>

      <aside className="easy-aside" aria-label="안내">
        {helpOpen && (
          <section className="easy-side-card easy-help-card">
            <h2>도움이 필요하세요?</h2>
            {fresh
              ? <p>하고 싶은 일을 말로 적고 <b>보내기</b>를 누르세요. 아래 카드를 눌러 시작해도 돼요.</p>
              : route.kind === 'sessions' || route.kind === 'plans'
                ? <p>목록에서 하나를 누르면 이 화면 안에서 열려요. 처음 화면은 위의 <b>홈</b>이에요.</p>
                : <p>한 단계 돌아가려면 위의 <b>← 이전</b> 줄을, 처음부터 하려면 <b>↺ 처음부터 다시</b>를 누르세요. 저장하기 전에는 아무것도 바뀌지 않아요.</p>}
          </section>
        )}
        <section className="easy-side-card">
          <h2>이렇게 쓰세요</h2>
          <ol className="easy-guide">
            <li><b>하고 싶은 일을 말로 적어요</b><span>“점심에 줄이 길어요”처럼 평소 말투면 돼요</span></li>
            <li><b>조건을 확인해요</b><span>틀린 곳만 고치면 돼요</span></li>
            <li><b>결과를 보고 저장해요</b><span>배치표·구매안·주문 문구가 나와요</span></li>
          </ol>
        </section>
      </aside>
      </div>

      <footer className="app-footer">
        <span>SOL루션 · 사장님이 판단할 수 있도록</span>
        <span>계획 저장까지, 실제 실행은 사장님이.</span>
      </footer>

      {guideOpen && (
        <Modal title="쉬운 화면 사용법" description="세 단계면 끝나요." onClose={() => setGuideOpen(false)} wide closeOnBackdrop>
          <div className="easy-modal-body">
          <ol className="easy-guide easy-guide-modal">
            <li><b>하고 싶은 일을 말로 적어요</b><span>장보기든 점심 인원이든 고를 필요 없이, 말한 내용에 맞춰 바로 시작해요.</span></li>
            <li><b>조건을 확인해요</b><span>미리 채워진 조건이 맞으면 그대로, 틀린 곳만 "고치기"로 바꿔요.</span></li>
            <li><b>결과를 보고 저장해요</b><span>맨 위가 추천이에요. 배치표는 인쇄하고, 주문 문구는 복사해서 보내요.</span></li>
            <li><b>나중에 이어서 봐요</b><span>"하던 일 이어하기"에서 멈춘 곳부터, "저장한 계획"에서 저장한 결과를 다시 볼 수 있어요.</span></li>
          </ol>
          <div className="easy-actions">
            <button type="button" className="easy-primary" onClick={startTour}>따라 하며 배우기</button>
            <button type="button" className="easy-secondary" onClick={() => setGuideOpen(false)}>닫기</button>
          </div>
          </div>
        </Modal>
      )}
      {tourOn && inFlow && (() => {
        const now = currentStep(phase, feature, tourResultIndex)
        if (!now) return null
        return (
          <TourOverlay
            step={now.step}
            number={now.number}
            onClose={endTour}
            onNext={() => (now.number >= TOUR_TOTAL ? endTour() : setTourResultIndex((i) => i + 1))}
            // 이전: 결과 안에서는 앞 안내로, 단계 경계에서는 화면도 한 단계 뒤로(back.ts와 같은 규칙).
            onPrev={now.number > 1 ? () => (phase === 'result' && tourResultIndex > 0 ? setTourResultIndex((i) => i - 1) : back && doBack(back.action)) : undefined}
          />
        )
      })()}
    </div>
  )

}

/** 조건 때문에 계산이 안 될 때(살 수 있는 조합 없음 등). 서버·연결 오류와 구분한다. */
class InputError extends Error {}

/** 확인 카드에서 고칠 수 있는 값 묶음. 저장된 버전과 같으면 새 버전을 만들지 않는다. */
function valuesKey(budget: number | null, deliveries: number | null, orders: number, owner: boolean, wage: number, lastOrder: number) {
  return JSON.stringify([budget, deliveries, orders, owner, wage, lastOrder])
}
