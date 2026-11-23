// 기본 화면: 시니어 사장님용 쉬운 화면(주소에 mode가 없거나 ?mode=easy). 예전 업무 화면은 ?mode=classic.
// 멘토링(11.20): 처음부터 대화로 시작하고, 매입·운영을 고르지 않아도 말에 맞춰 바로 진행.
// 강사님·멘토님: 운영은 "시뮬레이션해 보고 배치표를 받는다"가 결과로 보이게.
// 하던 일 이어하기·저장한 계획도 원래 업무 화면으로 넘기지 않고 이 화면 안(#/work, #/plans)에서 연다.
// 근거: 시니어 사장님 화면 간소화 레퍼런스 조사(결론을 위로, 근거는 한 단계 아래, 이미 아는 값은 확인만,
// 행동형 버튼 문구, 확정 전 요약 확인).
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { loadOperationResult, runOperation } from '../api/operationApi'
import { workflowApi, WorkflowError } from '../api/workflowApi'
import { Modal } from '../components/common/Ui'
import { backOf } from '../features/easy/back'
import type { BackAction } from '../features/easy/back'
import { parseHash, routeHash } from '../features/easy/hashRoute'
import type { EasyRoute } from '../features/easy/hashRoute'
import { changeSentence, chatBubbles, openQuestion, outcome, questionChoices } from '../features/easy/agent'
import type { Outcome } from '../features/easy/agent'
import { itemFacts, needLine } from '../features/easy/amounts'
import { applyChanges, changeText, usable } from '../features/easy/suggest'
import type { Suggested } from '../features/easy/suggest'
import Explain from '../features/easy/Explain'
import { PlanList, SessionList } from '../features/easy/Lists'
import QuotePaste from '../features/easy/QuotePaste'
import { OPERATION_FORM, PURCHASE_INPUT } from '../features/easy/practiceStore'
import Recent from '../features/easy/Recent'
import { CHOICE, cleanTitle, featureTag, when } from '../features/easy/recentFormat'
import { guessFeature } from '../features/easy/route'
import type { EasyFeature } from '../features/easy/route'
import { currentStep, markTourSeen, TOUR_TOTAL, tourSeen } from '../features/easy/tour'
import TourOverlay from '../features/easy/TourOverlay'
import { ROSTER_TOUR_TOTAL, rosterStep } from '../features/operation/easy/rosterTour'
import type { RosterStage } from '../features/operation/easy/rosterTour'
import { Card, OperationView, Pick, PurchaseView } from '../features/easy/views'
import type { Prepared } from '../features/easy/views'
import { isRosterResult, LUNCH_MODE_PARAM, ROSTER_MODE } from '../features/operation/easy/rosterSwitch'
import type { RosterOpened } from '../features/operation/easy/EasyRoster'
import type { OperationResult } from '../features/operation/types'
import { won } from '../features/operation/workspace/format'
import type { OperationPlan } from '../types/api'
import type { EventData, JsonObject, PurchaseResult } from '../types/workflow'
import '../features/easy/easy.css'

// 점심 인원 2번(추천 근무표). 고를 때만 불러온다(가게 파일 읽기 도구가 커서 첫 화면 번들에 넣지 않는다).
const EasyRoster = lazy(() => import('../features/operation/easy/EasyRoster'))

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
  // 기본은 "직원 근무표"(운영 2번). ?mode=lunch면 같은 자리가 예전 "점심 인원"(1번) 카드가 된다.
  ROSTER_MODE
    ? { feature: 'operation', title: '직원 근무표', desc: '가게 판매 데이터로 일주일 근무표를 만들어 드려요', message: '일주일 근무표 만들어 줘', result: '추천 근무표' }
    : { feature: 'operation', title: '점심 인원', desc: '바쁜 점심에 몇 명이 일하면 덜 기다릴지', message: '점심에 알바 한 명 더 쓰면 어때?', result: '추천 배치표' },
]

/** 1번(점심 인원 배치) ↔ 2번(추천 근무표) 전환 주소. 1번을 없애면 이 링크도 뺀다. */
const MODE_SWITCH = ROSTER_MODE
  ? { href: `${window.location.pathname}?mode=${LUNCH_MODE_PARAM}`, label: '예전 "점심 인원 배치"로 보기' }
  : { href: window.location.pathname, label: '새 "직원 근무표"로 보기' }

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
// 업무를 만드는 매장. 예전 업무 화면·견적 화면과 같은 값을 쓴다.
const STORE_ID = Number(import.meta.env.VITE_STORE_ID ?? 1)
/** 아직 응답을 못 받은 말·답. 연결이 끊겼을 때 같은 요청 키로 다시 보내 중복 저장을 막는다. */
type Pending = { kind: EasyFeature; sessionId: number; payload: JsonObject; key: string }
/** 화면 상태에 그려지기 전의 최신 조건(AI가 방금 바꾼 값 등)으로 계산할 때 */
type Fresh = { kind: EasyFeature; input: JsonObject; values: string; changed?: boolean }

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
  // 점심 인원을 추천 근무표(2번)로 볼지. 새로 시작하면 주소(기본 2번, ?mode=lunch면 1번)로, 이어서 열면 결과 종류로 정한다.
  const [roster, setRoster] = useState(false)
  const [rosterOpened, setRosterOpened] = useState<RosterOpened | null>(null)
  // 근무표 화면 안의 한 단계 뒤로(조건 확인 → 데이터 고르기). 있으면 "← 이전" 줄이 이걸 쓴다.
  const [rosterBack, setRosterBack] = useState<{ label: string; run: () => void } | null>(null)
  const [rosterStage, setRosterStage] = useState<RosterStage>(null) // 따라 하며 배우기: 데이터 고르기/조건 확인
  // 근무표 결과에 새로 들어오면 따라 하며 배우기를 결과 첫 안내(맨 위가 추천)부터 보여 준다.
  useEffect(() => {
    if (roster && phase !== 'result') setTourResultIndex(0)
  }, [roster, phase])
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
  // AI 대화: 답을 기다리는 서버 질문, AI가 읽는 중인지, 다시 보낼 말, 조건이 아직 없는 업무(견적에서 못 읽은 값 등)
  const [question, setQuestion] = useState<EventData | null>(null)
  const [thinking, setThinking] = useState(false)
  const [pending, setPending] = useState<Pending | null>(null)
  const [chatError, setChatError] = useState('')
  const [reply, setReply] = useState('')
  const [noInput, setNoInput] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  // 장보기 계산이 안 됐을 때 서버가 준 바꿀 값 제안(칸·값)과 문장 제안
  const [blocked, setBlocked] = useState<{ changes: Suggested[]; tips: string[] } | null>(null)
  // 지금 조건(서버 입력)과, 업무 종류를 못 정해서 되물을 때 사장님이 처음 한 말
  const inputRef = useRef<JsonObject | null>(null)
  const firstWordsRef = useRef<string | null>(null)

  // 대화 중에는 마지막 말이 보이게, 결과가 나오면 추천 문장부터 보이게(스크롤하지 않아도 결론이 보이도록).
  useEffect(() => {
    // 점심 인원 추천 근무표(2번)는 결과 화면 맨 위(결론)부터 보이게 한다(결과 자리 표시가 근무표 화면 아래에 있어서).
    if (phase === 'result' && feature === 'operation' && roster) window.scrollTo({ top: 0 })
    else if (phase === 'result') resultRef.current?.scrollIntoView({ block: 'start' })
    else endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [bubbles, phase, feature, roster])

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
    resumeRef.current = null; setContext(null); setPrepared(null); setRoster(false); setRosterOpened(null); setPurchase(null); setOperation(null); setSaved(''); setSavedFor(null); setSavedChoice(null)
    shownResultRef.current = null
    setQuestion(null); setThinking(false); setPending(null); setChatError(''); setReply(''); setNoInput(false); setQuoteOpen(false); setBlocked(null)
    inputRef.current = null; firstWordsRef.current = null
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

  /** 메뉴 "받은 견적 넣기": 장보기를 새로 시작하고 견적 붙여넣기를 바로 연다(거래처 견적 → 장보기 순서). */
  function startQuote() {
    window.history.replaceState(null, '', routeHash({ kind: 'home' }))
    open({ kind: 'home' })
    say('owner', '받은 견적으로 장보기')
    begin('purchase', null, true)
    setQuoteOpen(true)
  }

  /** 업무에 저장된 조건(새 업무면 연습 가게 값)으로 확인 카드를 채운다. 돌려주는 값은 저장 비교용 묶음. */
  function fill(kind: EasyFeature, value: JsonObject) {
    inputRef.current = value
    setNoInput(false)
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
      const roster = kind === 'operation' && (await isRosterResult(session.latest_result_id, session.current_input ?? null))
      // 판별을 기다리는 사이 다른 업무를 열었으면(결과가 근무표든 아니든) 여기서 멈춘다.
      if (token !== tokenRef.current) return
      if (roster) {
        // 추천 근무표 업무: 조각(EasyRoster)이 결과(있으면)나 조건 확인을 열고 단계를 알려 준다. 대화 기록·빠진 값 카드는 쓰지 않는다.
        if (session.current_input) fill(kind, session.current_input)
        setFeature(kind)
        setContext({ kind: 'session', feature: kind, title: cleanTitle(session.title), sessionId: id })
        setRoster(true)
        setRosterOpened({ sessionId: id, resultId: session.latest_result_id })
        return
      }
      const messages = await workflowApi.allMessages(id)
      if (token !== tokenRef.current) return
      // 조건이 아직 없는 업무(견적에서 못 읽은 값을 묻는 중 등)는 연습 가게 값으로 채우지 않는다. 질문에 답해서 채운다.
      const values = session.current_input ? fill(kind, session.current_input) : ''
      if (!session.current_input) { inputRef.current = null; setBase({}); setNoInput(true) }
      setBubbles(chatBubbles(messages))
      setQuestion(openQuestion(messages, session.current_version_id))
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
      if (kind === 'operation' && (await isRosterResult(plan.result_id, null))) {
        const gone = await workflowApi.context(plan.session_id).then(() => false, () => true)
        if (token !== tokenRef.current) return
        setFeature(kind)
        setContext({ kind: 'plan', feature: kind, title: CHOICE[plan.selected_choice_key] ?? plan.selected_choice_key, sessionId: plan.session_id, sessionGone: gone })
        setSavedChoice(plan.selected_choice_key)
        setRoster(true)
        setRosterOpened({ sessionId: plan.session_id, resultId: plan.result_id, savedChoice: plan.selected_choice_key, savedNote: `${when(plan.confirmed_at)}에 저장한 계획이에요`, readOnly: true })
        return
      }
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

  /** 새 업무 시작: 연습 가게 값으로 업무를 바로 만들어 두고, 사장님이 한 말은 AI에게 보낸다(말 속 조건이 있으면 바로 반영). */
  function begin(next: EasyFeature, words?: string | null, lazy = false) {
    const practice = next === 'purchase' ? PURCHASE_INPUT : NEW_OPERATION
    setFeature(next)
    // 직원 근무표(2번)는 EasyRoster가 업무 만들기·조건·말로 고치기를 맡는다. 여기서는 업무를 만들거나 AI에 보내지 않는다.
    const rosterOn = next === 'operation' && ROSTER_MODE
    setRoster(rosterOn)
    if (rosterOn) {
      // 첫마디(words)는 일부러 넘기지 않는다: 이 말은 근무표 화면으로 오는 데 쓰였고("일주일 근무표 만들어 줘"),
      // 근무표는 판매 데이터를 고른 뒤에야 조건을 알아들을 수 있다. 조건은 근무표 화면의 말 칸에서 바꾼다.
      setBase(NEW_OPERATION)
      setPhase('confirm')
      say('agent', '일주일 근무표를 만들어 드려요.')
      return
    }
    const values = fill(next, practice)
    setPhase('confirm')
    say('agent', next === 'purchase'
      ? '이번 주 장보기 계획을 세워 볼게요. 바꿀 조건이 있으면 말로 알려 주세요.'
      : '점심 인원 배치를 돌려 볼게요. 바꿀 조건이 있으면 말로 알려 주세요.')
    // lazy: 받은 견적으로 시작할 때는 업무를 미리 만들지 않는다(견적이 따로 업무를 만들므로, 빈 업무가 목록에 쌓이지 않게).
    // 그 뒤 말로 바꾸거나 계산하면 그때 만든다(talk·ready).
    if (lazy) return
    const screen = screenRef.current
    const job = prepRef.current.catch(() => undefined).then(async () => {
      if (screen !== screenRef.current) throw new Error('다른 화면으로 옮겼어요.')
      return createSession(next, practice, values, screen)
    })
    prepRef.current = job
    job.catch((cause) => { if (screen === screenRef.current) setChatError(cause instanceof Error ? cause.message : '업무를 만들지 못했어요.') })
    // 따라 하며 배우기 중에는 안내 순서가 흐트러지지 않게 AI에게 보내지 않는다.
    if (words && !tourOn) talk(next, { event_type: 'message', content: words }, null)
  }

  /** 연습 가게 값으로 업무를 만들고 조건을 저장한다(확인 전). 주소도 이 업무로 바꿔, 새로 고쳐도 같은 업무가 다시 열리게 한다. */
  async function createSession(next: EasyFeature, input: JsonObject, values: string, screen: number) {
    const created = await workflowApi.create(STORE_ID, next, 'agent', next === 'purchase' ? '[쉬운 화면] 이번 주 장보기' : '[쉬운 화면] 점심 인원 배치')
    if (screen === screenRef.current) resumeRef.current = { sessionId: created.session_id, versionId: null, versionNo: 0, confirmed: false, values: '' }
    markSession(created.session_id, screen)
    return saveInput(created.session_id, null, input, values, screen, false)
  }

  /** 업무를 만들자마자 주소를 그 업무로 바꾼다(같은 화면일 때만). 조건 저장·계산이 실패하거나 멈춰도 새로 고치면 그 업무가 다시 열린다. */
  function markSession(id: number, screen: number) {
    if (screen !== screenRef.current) return
    window.history.replaceState(null, '', routeHash({ kind: 'session', id }))
    setRoute({ kind: 'session', id })
    setStartedHere(true)
  }

  function send(value: string) {
    const words = value.trim()
    if (!words) return
    say('owner', words)
    setText('')
    const guessed = guessFeature(words)
    if (guessed) begin(guessed, words)
    else {
      firstWordsRef.current = words
      setPhase('ask')
      say('agent', '어떤 일을 도와드릴까요?')
    }
  }

  /** 확인 카드에 보이는 값들. 무엇이 바뀌었는지 한 문장으로 알려 줄 때 쓴다. */
  function facts(kind: EasyFeature, input: JsonObject | null): Record<string, string> {
    if (!input) return {}
    if (kind === 'purchase') {
      const b = asNumber(input.budget_krw)
      const d = asNumber(input.max_delivery_count)
      return { '예산': b === null ? '정하지 않음' : won(b), '배송 횟수': d === null ? '정하지 않음' : `${d}번까지`, '계획 기간': `${asNumber(input.planning_days) ?? 7}일`, ...itemFacts(input.items) }
    }
    const form = asObject(input.operation_form) ?? {}
    return {
      '하루 주문': `${asNumber(form.daily_orders) ?? OPERATION_FORM.daily_orders}건`,
      '사장님 근무': form.is_owner_working === false ? '안 함' : '함',
      '직원 시급': won(asNumber(form.hourly_wage_krw) ?? OPERATION_FORM.hourly_wage_krw),
      '라스트 오더': lastOrderLabel(toMinutes(form.last_order_time) ?? DEFAULT_LAST_ORDER),
    }
  }

  /** 말·질문 답을 AI에게 보낸다. 업무 만들기·조건 저장 줄 뒤에 서서, 앞 요청이 끝난 최신 입력 버전 기준으로 보낸다. */
  function talk(kind: EasyFeature, body: JsonObject, shown: string | null, again?: Pending) {
    if (shown) say('owner', shown)
    setThinking(true); setChatError('')
    const screen = screenRef.current
    // "고치기"로 바꾼 값이 아직 저장 전이면, 그 값을 먼저 저장하고 그 버전 기준으로 말을 보낸다(AI 응답이 고친 값을 덮지 않게).
    const edited = !again && phase === 'confirm' && inputRef.current && !noInput && featureNow === kind ? { input: buildInput(kind), values: valuesNow } : null
    const job = prepRef.current.catch(() => undefined).then(async () => {
      if (screen !== screenRef.current) return
      // 업무를 아직 안 만든 채 시작했으면(받은 견적 넣기) 지금 화면 조건으로 먼저 만든다.
      if (!resumeRef.current && !again && inputRef.current && !noInput) {
        await createSession(kind, edited?.input ?? inputRef.current, edited?.values ?? valuesNow, screen)
        if (screen !== screenRef.current) return
      }
      let resume = resumeRef.current
      if (!resume) throw new Error('업무를 아직 만들지 못했어요. "↺ 처음부터 다시"를 눌러 주세요.')
      // 업무는 있는데 첫 조건 저장이 실패했으면(버전 없음) 화면 조건부터 저장한다. 안 그러면 AI가 빈 조건을 보고 답한다.
      if (resume.versionId === null && !again && inputRef.current && !noInput) {
        await saveInput(resume.sessionId, null, edited?.input ?? inputRef.current, edited?.values ?? valuesNow, screen, false)
        if (screen !== screenRef.current) return
        resume = resumeRef.current ?? resume
      }
      let payload = body
      if (edited && resume.versionId !== null && resume.values !== edited.values) {
        await saveInput(resume.sessionId, resume.versionId, edited.input, edited.values, screen, false)
        if (screen !== screenRef.current) return
        resume = resumeRef.current ?? resume
        // 조건을 새로 저장하면 그 전 질문은 지난 질문이 된다. 답은 보통 말로 보낸다.
        if (body.event_type === 'question_reply') {
          payload = { event_type: 'message', content: String(body.answer ?? '') }
          setQuestion(null)
        }
      }
      const request: Pending = again ?? { kind, sessionId: resume.sessionId, payload: { ...payload, base_version_id: resume.versionId }, key: crypto.randomUUID() }
      setPending(request)
      try {
        const response = await workflowApi.event(request.sessionId, request.payload, request.key)
        if (screen !== screenRef.current) return
        await apply(kind, resume.sessionId, outcome(response, resume.versionId), screen)
        // 조건을 다시 읽는 데까지 끝난 뒤에 지운다. 그 전에 실패하면 "다시 보내기"로 같은 요청(같은 키)을 다시 보낸다.
        if (screen === screenRef.current) setPending(null)
      } catch (cause) {
        // 서버가 받지 않은 요청(조건이 바뀜 등)은 다시 보내도 소용없다. 연결이 끊긴 것만 같은 키로 다시 보낸다.
        if (cause instanceof WorkflowError && cause.httpStatus && cause.httpStatus < 500) setPending(null)
        throw cause
      }
    })
    prepRef.current = job
    job.catch((cause) => {
      if (screen !== screenRef.current) return
      setChatError(cause instanceof WorkflowError && cause.code === 'STALE_INPUT'
        ? '그사이 조건이 바뀌었어요. 화면을 새로 열고 다시 말씀해 주세요.'
        : cause instanceof Error ? cause.message : 'AI에게 보내지 못했어요.')
    }).finally(() => { if (screen === screenRef.current) setThinking(false) })
  }

  async function apply(kind: EasyFeature, sessionId: number, out: Outcome, screen: number) {
    if (out.kind === 'question') { setQuestion(out.question); say('agent', out.message || '조금 더 알려 주세요.'); return }
    setQuestion(null)
    if (out.kind === 'use-form') { say('agent', out.message); if (inputRef.current) openEdit(); return }
    if (out.kind === 'refused') { say('agent', [out.message, ...out.suggestions].join(' ')); return }
    if (out.kind === 'same') {
      say('agent', out.message)
      if (out.run && inputRef.current && resumeRef.current) void calculate({ kind, input: inputRef.current, values: resumeRef.current.values })
      return
    }
    // 조건이 바뀜: 서버에 저장된 새 조건을 다시 읽어 확인 카드에 반영한다(아직 확인 전).
    const session = await workflowApi.context(sessionId)
    if (screen !== screenRef.current || !session.current_input) return
    const before = facts(kind, inputRef.current)
    const values = fill(kind, session.current_input)
    resumeRef.current = { sessionId, versionId: out.versionId, versionNo: out.versionNo, confirmed: false, values }
    const after = facts(kind, session.current_input)
    // 조건이 없던 업무(빠진 값을 답한 경우)는 채운 값을, 있던 업무는 바뀐 값만 알려 준다.
    // 바뀐 값은 사장님이 먼저 보고 계산한다(운영 AI 규칙: 값을 바꾼 말은 계산까지 바로 하지 않음).
    const next = kind === 'purchase' ? '맞으면 "구매안 계산하기"를 눌러 주세요.' : '맞으면 "배치표 만들기"를 누르거나 "비교해 줘"라고 말해 주세요.'
    // 채운 값은 큰 조건만(품목별 양까지 다 늘어놓으면 길다). 품목별 양은 카드의 "이번 주 쓸 양"에 보인다.
    const filled = Object.entries(after).filter(([label]) => !label.endsWith(' 쓸 양') && !label.endsWith(' 재고'))
    const said = Object.keys(before).length
      ? changeSentence(before, after) || '말씀하신 대로 조건을 바꿨어요.'
      : `조건을 채웠어요. ${filled.map(([label, value]) => `${label} ${value}`).join(' · ')}`
    say('agent', `${said}${/[.요]$/.test(said) ? '' : '.'} ${next}`)
    setEditing(false); setSnapshot(null)
    // "비교해 줘"처럼 계산까지 부탁한 말이면, 방금 바뀐 조건(아직 화면에 그려지기 전)으로 바로 계산한다.
    if (out.run) void calculate({ kind, input: session.current_input, values })
  }

  function sendReply(value: string) {
    const words = value.trim()
    if (!words || !feature || thinking) return
    setReply('')
    if (question?.question_id) talk(feature, { event_type: 'question_reply', question_id: question.question_id, answer: words }, words)
    else talk(feature, { event_type: 'message', content: words }, words)
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    send(text)
  }

  const operationForm = asObject(base.operation_form)
  const values = valuesKey(budget, deliveries, dailyOrders, ownerWorking, wage, lastOrder)
  // ready·calculate 안에서 같은 이름(values·feature)을 덮어 쓰기 전에, 지금 화면 값을 따로 둔다.
  const valuesNow = values
  const featureNow = feature

  function buildInput(kind: EasyFeature): JsonObject {
    if (kind === 'purchase') return { ...base, budget_krw: budget, max_delivery_count: deliveries }
    if (!operationForm) return base // 자세한 화면에서 만든 조건은 그대로 쓴다.
    return { ...base, operation_form: { ...operationForm, daily_orders: dailyOrders, is_owner_working: ownerWorking, hourly_wage_krw: wage, last_order_time: toHHMM(lastOrder) } }
  }

  // 조건을 새 버전으로 저장하고 입력 확인까지 마친다.
  // 저장(이벤트)은 서버에 먼저 남으므로, 확인이 실패해도 다시 시도할 때 이 새 버전부터 이어 가게 바로 기록해 둔다.
  // (옛 버전을 base로 다시 보내면 서버가 STALE로 거부한다.) 계산을 멈췄어도 같은 화면이면 기록하고, 다른 화면으로 옮겼을 때만 건너뛴다.
  async function saveInput(sessionId: number, baseVersionId: number | null, input: JsonObject, valueKey: string, screen: number, confirm = true) {
    const response = await workflowApi.event(sessionId, { event_type: 'form', form_input: input, base_version_id: baseVersionId }, crypto.randomUUID())
    const data = response.data as JsonObject | null
    const versionId = Number(data?.input_version_id)
    const versionNo = Number(data?.version_no)
    if (response.status !== 'ok' || !versionId) throw new Error(response.message || '조건을 저장하지 못했어요.')
    if (screen === screenRef.current) {
      resumeRef.current = { sessionId, versionId, versionNo, confirmed: false, values: valueKey }
      inputRef.current = input // 저장한 조건이 지금 조건(계산 불가 제안도 이 조건에 적용한다)
    }
    if (confirm) {
      await workflowApi.confirmInput(versionId, versionNo)
      if (screen === screenRef.current) resumeRef.current = { sessionId, versionId, versionNo, confirmed: true, values: valueKey }
    }
    return { sessionId, versionId, versionNo }
  }

  // 새 업무면 만들고, 이어서 하는 업무면 그 업무 안에서. 조건이 그대로면 저장된 버전을 다시 쓴다.
  async function ready(kind: EasyFeature, screen: number, fresh?: Fresh): Promise<Prepared> {
    const input = fresh?.input ?? buildInput(kind)
    const values = fresh?.values ?? valuesNow
    const resume = resumeRef.current
    if (!resume) {
      const created = await workflowApi.create(STORE_ID, kind, 'agent', kind === 'purchase' ? '[쉬운 화면] 이번 주 장보기' : '[쉬운 화면] 점심 인원 배치')
      // 조건 저장이 실패해도 다시 시도할 때 업무를 또 만들지 않게, 만든 업무를 먼저 기록해 둔다.
      if (screen === screenRef.current) resumeRef.current = { sessionId: created.session_id, versionId: null, versionNo: 0, confirmed: false, values: '' }
      markSession(created.session_id, screen)
      return saveInput(created.session_id, null, input, values, screen)
    }
    // changed: 확인 카드에 없는 칸(품목 보관 한도 등)만 바꾼 경우에도 새 조건으로 저장한다.
    if (resume.versionId === null || resume.values !== values || fresh?.changed) {
      return saveInput(resume.sessionId, resume.versionId, input, values, screen)
    }
    if (!resume.confirmed) await workflowApi.confirmInput(resume.versionId, resume.versionNo)
    return { sessionId: resume.sessionId, versionId: resume.versionId, versionNo: resume.versionNo }
  }

  /** 계산 불가 제안대로 조건을 바꿔 바로 다시 계산한다. 바뀐 값은 확인 카드에도 반영되고, 새 조건 버전으로 저장된다. */
  function applySuggested(changes: Suggested[]) {
    const input = inputRef.current ? applyChanges(inputRef.current, changes) : null
    if (!input || feature !== 'purchase') { setPhase('confirm'); openEdit(); return }
    const values = fill('purchase', input)
    say('agent', `제안대로 바꿨어요. ${changes.map(changeText).join(' · ')}. 이 조건으로 다시 계산할게요.`)
    void calculate({ kind: 'purchase', input, values, changed: true })
  }

  /** fresh: AI가 방금 바꾼 조건처럼 아직 화면 상태에 반영되기 전 값으로 계산할 때 */
  async function calculate(fresh?: Fresh) {
    const feature = fresh?.kind ?? featureNow
    // AI가 조건을 바꾸는 중에는 화면의 옛 값으로 계산(저장)하지 않는다. AI가 계산까지 부탁받은 경우는 fresh로 들어온다.
    if (!feature || (noInput && !fresh) || (thinking && !fresh)) return
    const token = tokenRef.current
    setPhase('running'); setError(''); setSaved(''); setSavedFor(null); setSavedChoice(null); setBlocked(null)
    // 이전 결과를 지운다. 계산이 실패했을 때 옛 결과와 새 조건(prepared)이 짝지어 보이거나 저장되지 않게.
    setPurchase(null); setOperation(null)
    shownResultRef.current = null
    try {
      // 앞선 준비 요청(그만두기로 결과만 버린 것 포함)이 끝난 뒤에 이어서 준비한다. 앞 요청이 실패해도 이번 요청은 진행한다.
      const screen = screenRef.current
      const job = prepRef.current.catch(() => undefined).then(() => {
        // 줄에서 기다리는 사이 다른 업무를 열었으면(화면이 바뀌면) 실행하지 않는다. 열린 업무에 이전 화면 조건이 저장되지 않게.
        if (screen !== screenRef.current) throw new Error('다른 화면으로 옮겨 계산을 멈췄어요.')
        return ready(feature, screen, fresh)
      })
      prepRef.current = job
      const done = await job
      // 계산을 그만둬도 이미 만든 업무의 주소는 남긴다(같은 화면일 때만). 새로 고쳐도 그 업무가 다시 열리게.
      if (screen === screenRef.current && route.kind !== 'session') {
        window.history.replaceState(null, '', routeHash({ kind: 'session', id: done.sessionId }))
        setRoute({ kind: 'session', id: done.sessionId })
        setStartedHere(true)
      }
      if (token !== tokenRef.current) return
      // 다시 계산하면 같은 업무 안에서 이어지게 한다.
      resumeRef.current = { sessionId: done.sessionId, versionId: done.versionId, versionNo: done.versionNo, confirmed: true, values: fresh?.values ?? valuesNow }
      setPrepared(done)
      if (feature === 'purchase') {
        const response = await workflowApi.calculate(done.sessionId, done.versionId, crypto.randomUUID())
        const resultId = Number((response.data as JsonObject | null)?.result_id)
        const result = await workflowApi.result(resultId)
        if (token !== tokenRef.current) return
        if (result.response_status !== 'ok') {
          // 계산 불가: 서버가 준 "이 칸을 이 값으로" 제안과 문장 제안을 함께 보여 준다.
          const summary = result.summary as PurchaseResult['summary'] & { suggestions?: unknown }
          setBlocked({ changes: usable(summary.suggested_changes), tips: Array.isArray(summary.suggestions) ? summary.suggestions.filter((t): t is string => typeof t === 'string') : [] })
          throw new InputError(summary.message || '이 조건으로는 살 수 있는 조합이 없어요.')
        }
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
          <a href="#" onClick={(e) => { e.preventDefault(); startQuote() }}>받은 견적 넣기</a>
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
            {roster && rosterBack
              ? <button type="button" className="easy-back" onClick={rosterBack.run}>← {rosterBack.label}</button>
              : <button type="button" className="easy-back" onClick={() => doBack(back.action)}>← {back.label}</button>}
            {context && (
              <p>
                <span className={`easy-tag ${context.feature}`}>{featureTag(context.feature, { title: context.title })}</span>
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
            <p>{ROSTER_MODE ? '카페 사장님의 장보기와 직원 근무표를 대신 계산해 드려요.' : '카페 사장님의 장보기와 점심 인원 배치를 대신 계산해 드려요.'}</p>
          </section>
        )}

        {/* 추천 근무표(2번)는 대화 말풍선 없이 조건 카드·결과만(시작할 때 보낸 예시 말은 사장님이 쓴 말이 아니다) */}
        {inFlow && !(feature === 'operation' && roster) && (
          <div className="easy-chat" role="log" aria-live="polite">
            {bubbles.map((bubble, i) => (
              <p key={i} className={`easy-bubble ${bubble.role}`}>{bubble.text}</p>
            ))}
            {thinking && <p className="easy-bubble agent easy-thinking" role="status">말씀을 읽고 있어요…</p>}
          </div>
        )}

        {onHome && (phase === 'start' || phase === 'ask') && (
          <div data-tour={phase === 'start' ? 'input' : undefined}>
            {phase === 'ask' ? (
              <div className="easy-choices" data-tour="choices">
                <button type="button" className="easy-big" onClick={() => { say('owner', '이번 주 장보기 계획'); begin('purchase', firstWordsRef.current) }}>이번 주 장보기 계획 세우기</button>
                <button type="button" className="easy-big" onClick={() => { say('owner', ROSTER_MODE ? '직원 근무표' : '점심 인원 배치'); begin('operation', firstWordsRef.current) }}>{ROSTER_MODE ? '직원 근무표 만들기' : '점심 인원 배치 돌려 보기'}</button>
              </div>
            ) : null}
            <form className="easy-input" onSubmit={submit}>
              <label htmlFor="easy-text" className="easy-sr">사장님 말</label>
              <textarea id="easy-text" rows={2} value={text} placeholder={ROSTER_MODE ? '예: 일주일 근무표 만들어 줘' : '예: 점심에 줄이 너무 길어요'} onChange={(e) => setText(e.target.value)}
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
                {/* 임시: 1번↔2번 전환(발표 전 비교용). 월요일에 하나로 정하면 뺀다. */}
                <p className="easy-mode-switch"><a href={MODE_SWITCH.href}>{MODE_SWITCH.label}</a></p>
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

        {inFlow && phase === 'confirm' && feature && !roster && noInput && (
          <Card title="조건을 마저 알려 주세요" tour="confirm">
            <p>{question ? '아직 정해지지 않은 값이 있어요. 아래 질문에 답하면 조건이 채워져요.' : '이 업무에는 아직 저장된 조건이 없어요. 아래에 말로 알려 주세요.'}</p>
          </Card>
        )}

        {inFlow && phase === 'confirm' && feature === 'purchase' && !noInput && (
          <Card title="이 조건이 맞나요?" tour="confirm">
            <ul className="easy-facts">
              <li><span>계획 기간</span><b>{asNumber(base.planning_days) ?? 7}일</b></li>
              <li><span>예산</span><b>{budget === null ? '정하지 않았어요' : `${won(budget)}까지`}</b></li>
              <li><span>배송 받는 횟수</span><b>{deliveries === null ? '정하지 않았어요' : `${deliveries}번까지`}</b></li>
              <li><span>살 품목</span><b>{items.length ? items.join(' · ') : '아직 없어요'}</b></li>
              {items.length > 0 && <li><span>이번 주 쓸 양</span><b>{needLine(base.items)}</b></li>}
              <li><span>받은 견적</span><b>{supplierCount ? `거래처 ${supplierCount}곳` : '아직 없어요'}</b></li>
            </ul>
            {!quoteOpen && (
              <p className="easy-quote-open">
                <button type="button" className="easy-text-button" onClick={() => setQuoteOpen(true)}>내가 받은 견적 문자로 계산하기 ›</button>
              </p>
            )}
            {editing && (
              <div className="easy-edit">
                <Pick label="예산" value={budget ?? Number.NaN} options={withCurrent([150000, 200000, 250000], budget)} format={(v) => won(v)} onPick={setBudget} />
                <Pick label="배송 받는 횟수" value={deliveries ?? Number.NaN} options={withCurrent([1, 2, 3], deliveries)} format={(v) => `${v}번까지`} onPick={setDeliveries} />
              </div>
            )}
            {!purchaseReady && <p className="easy-note">예산과 배송 받는 횟수를 골라 주세요.</p>}
            <div className={`easy-cta${editing ? ' easy-cta-static' : ''}`}>
              <button type="button" className="easy-primary" disabled={!purchaseReady || thinking} onClick={() => void calculate()}>구매안 계산하기</button>
              {editing ? (
                <>
                  <button type="button" className="easy-secondary" onClick={() => { setEditing(false); setSnapshot(null) }}>다 고쳤어요</button>
                  <button type="button" className="easy-text-button" onClick={cancelEdit}>고친 것 되돌리기</button>
                </>
              ) : <button type="button" className="easy-secondary" onClick={openEdit}>고치기</button>}
            </div>
          </Card>
        )}

        {feature === 'operation' && roster && (inFlow || route.kind === 'plan') && (
          <Suspense fallback={null}>
            <EasyRoster
              key={screenNo}
              phase={phase}
              onPhase={setPhase}
              opened={rosterOpened}
              onBack={setRosterBack}
              onStage={setRosterStage}
              onSession={(id) => {
                // 새 업무를 만들면 주소를 그 업무로 바꿔, 새로 고쳐도 "하던 일"로 다시 열리게 한다.
                if (route.kind !== 'session') {
                  window.history.replaceState(null, '', routeHash({ kind: 'session', id }))
                  setRoute({ kind: 'session', id })
                  setStartedHere(true)
                }
              }}
            />
          </Suspense>
        )}

        {inFlow && phase === 'confirm' && feature === 'purchase' && quoteOpen && (
          <QuotePaste key={screenNo} storeId={STORE_ID} onDone={(id) => go({ kind: 'session', id })} onClose={() => setQuoteOpen(false)} />
        )}

        {inFlow && phase === 'confirm' && feature === 'operation' && !roster && !noInput && (
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
              <button type="button" className="easy-primary" disabled={thinking} onClick={() => void calculate()}>배치표 만들기</button>
              {operationForm && (editing ? (
                <>
                  <button type="button" className="easy-secondary" onClick={() => { setEditing(false); setSnapshot(null) }}>다 고쳤어요</button>
                  <button type="button" className="easy-text-button" onClick={cancelEdit}>고친 것 되돌리기</button>
                </>
              ) : <button type="button" className="easy-secondary" onClick={openEdit}>고치기</button>)}
            </div>
          </Card>
        )}

        {/* 말로 바꾸기: AI가 말을 조건으로 바꾸고, 모르는 값은 질문으로 되묻는다. 숫자 계산은 하지 않는다. */}
        {inFlow && phase === 'confirm' && feature && !roster && !quoteOpen && (
          <section className="easy-talk" aria-label="말로 바꾸기">
            {question && (
              <div className="easy-question" role="group" aria-label="AI 질문">
                {/* 질문 문장은 바로 위 말풍선에 있다. 카드에는 답하는 방법만(같은 문장을 두 번 보이지 않게). */}
                <p className="easy-question-label">AI가 물어봤어요</p>
                <p><b>{questionChoices(question).length ? '아래에서 고르거나 직접 적어 주세요.' : '아래 칸에 답을 적어 주세요.'}</b></p>
                {questionChoices(question).length > 0 && (
                  <div className="easy-question-choices">
                    {questionChoices(question).map((choice) => (
                      <button key={choice} type="button" className="easy-secondary" disabled={thinking}
                        onClick={() => question.question_id && talk(feature, { event_type: 'question_reply', question_id: question.question_id, answer: choice }, choice)}>
                        {choice}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!question && <p className="easy-talk-label">바꿀 게 있으면 말로 적어 주세요</p>}
            <form className="easy-input" onSubmit={(e) => { e.preventDefault(); sendReply(reply) }}>
              <label htmlFor="easy-reply" className="easy-sr">{question ? '질문에 답하기' : '말로 조건 바꾸기'}</label>
              <textarea id="easy-reply" rows={2} value={reply}
                placeholder={question ? '여기에 답을 적어 주세요' : feature === 'purchase' ? '예: 예산은 15만 원까지만, 배송은 한 번만 받을게요' : '예: 내일은 바쁜 날이라 주문이 250건쯤 돼요'}
                onChange={(e) => setReply(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendReply(reply) } }} />
              <button type="submit" className="easy-primary" disabled={!reply.trim() || thinking}>보내기</button>
            </form>
            {chatError && (
              <p role="alert" className="easy-note">
                {chatError}{' '}
                {pending && !thinking && <button type="button" className="easy-text-button" onClick={() => talk(pending.kind, {}, null, pending)}>다시 보내기</button>}
              </p>
            )}
          </section>
        )}

        {phase === 'running' && !roster && (
          <div className="easy-running" role="status">
            <span className="easy-spinner" aria-hidden />
            <span>{feature === 'operation' ? '30번 돌려 보는 중이에요' : '가장 싼 조합을 찾는 중이에요'}</span>
            {back && <button type="button" className="easy-secondary easy-running-cancel" onClick={() => doBack(back.action)}>그만두기</button>}
          </div>
        )}

        {phase === 'error' && !(feature === 'operation' && roster) && (
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
              {inFlow && blocked && blocked.changes.length > 0 && (
                <div className="easy-suggest">
                  <h3>이렇게 바꾸면 살 수 있어요</h3>
                  <ul>{blocked.changes.map((change) => <li key={change.path}>{changeText(change)}</li>)}</ul>
                </div>
              )}
              {inFlow && blocked && !blocked.changes.length && blocked.tips.length > 0 && (
                <ul className="easy-suggest">{blocked.tips.map((tip) => <li key={tip}>{tip}</li>)}</ul>
              )}
              <div className="easy-actions">
                {inFlow && blocked && blocked.changes.length > 0 && (
                  <button type="button" className="easy-primary" disabled={thinking} onClick={() => applySuggested(blocked.changes)}>이렇게 바꿔서 다시 계산하기</button>
                )}
                {inFlow && <button type="button" className={blocked?.changes.length ? 'easy-secondary' : 'easy-primary'} onClick={() => { setPhase('confirm'); openEdit() }}>조건 고쳐서 다시 하기</button>}
                <button type="button" className="easy-secondary" onClick={restart}>처음으로</button>
              </div>
            </Card>
          ) : (
            <Card title="잠깐 연결이 안 됐어요">
              <p>{error}</p>
              <p className="easy-muted">조건은 그대로예요. 잠시 뒤 "다시 시도"를 눌러 주세요.</p>
              <div className="easy-actions">
                {inFlow && <button type="button" className="easy-primary" disabled={thinking} onClick={() => void calculate()}>다시 시도</button>}
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
        {phase === 'result' && (purchase || operation) && prepared && (
          <Explain key={(purchase ?? operation)!.result_id} resultId={(purchase ?? operation)!.result_id} />
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
            <li><b>하고 싶은 일을 말로 적어요</b><span>{ROSTER_MODE ? '“일주일 근무표 만들어 줘”' : '“점심에 줄이 길어요”'}처럼 평소 말투면 돼요</span></li>
            <li><b>조건을 확인해요</b><span>틀린 곳은 말로 바꾸거나 "고치기"로 바꿔요</span></li>
            <li><b>결과를 보고 저장해요</b><span>{ROSTER_MODE ? '구매안·주문 문구·근무표가 나와요' : '배치표·구매안·주문 문구가 나와요'}</span></li>
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
            <li><b>하고 싶은 일을 말로 적어요</b><span>{ROSTER_MODE ? '장보기든 근무표든' : '장보기든 점심 인원이든'} 고를 필요 없이, 말한 내용에 맞춰 바로 시작해요.</span></li>
            <li><b>조건을 확인해요</b><span>미리 채워진 조건이 맞으면 그대로, 틀린 곳은 "예산은 15만 원까지만"처럼 말로 바꾸거나 "고치기"로 바꿔요. 받은 견적 문자를 붙여 넣어 계산할 수도 있어요.</span></li>
            <li><b>결과를 보고 저장해요</b><span>{ROSTER_MODE
              ? '맨 위가 추천이에요. 장보기는 "설명 듣기"로 쉬운 말 설명을 듣고 주문 문구를 복사해서 보내요. 근무표는 세 안을 비교하고 인쇄해요.'
              : '맨 위가 추천이에요. "설명 듣기"를 누르면 쉬운 말로 풀어 드려요. 배치표는 인쇄하고, 주문 문구는 복사해서 보내요.'}</span></li>
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
        // 추천 근무표(2번)는 데이터 고르기·세 근무표 비교가 더 있어 단계가 따로다(rosterTour.ts).
        const isRoster = feature === 'operation' && roster
        const now = isRoster ? rosterStep(phase, rosterStage, tourResultIndex) : currentStep(phase, feature, tourResultIndex)
        // 근무표 모드에서는 첫 단계에 아직 장보기(5단계)인지 근무표(7단계)인지 몰라 번호만 보인다.
        const total = isRoster ? ROSTER_TOUR_TOTAL : ROSTER_MODE && !feature ? null : TOUR_TOTAL
        if (!now) return null
        return (
          <TourOverlay
            step={now.step}
            number={now.number}
            total={total}
            onClose={endTour}
            onNext={() => (total !== null && now.number >= total ? endTour() : setTourResultIndex((i) => i + 1))}
            // 이전: 결과 안에서는 앞 안내로, 단계 경계에서는 화면도 한 단계 뒤로(back.ts와 같은 규칙).
            onPrev={now.number > 1 ? () => (phase === 'result' && tourResultIndex > 0 ? setTourResultIndex((i) => i - 1) : isRoster && rosterBack ? rosterBack.run() : back && doBack(back.action)) : undefined}
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
