import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { classifyMenuTypes, loadRosterResult, rosterChat, rosterExplain, startRosterResult, warmRoster } from '../../../api/operationApi'
import { workflowApi } from '../../../api/workflowApi'
import type { JsonObject } from '../../../types/workflow'
import { Card, Pick } from '../../easy/views'
import { blocking, formFromPlan } from '../roster/labModel'
import { rosterDays, rosterWorkers, skipReason } from '../roster/rosterRequest'
import { optionsFromStored, rosterDigest } from '../roster/rosterTypes'
import type { OptionKey, RosterOptions, RosterSummary, StoredRosterResult } from '../roster/rosterTypes'
import { waitRoster } from '../roster/rosterJob'
import type { RosterProgress as RosterProgressData } from '../roster/rosterTypes'
import RosterProgress from './RosterProgress'
import { ROSTER_SCOPE_DEFAULT } from './rosterSwitch'
import { exampleTeam } from '../roster/team'
import { DEFAULT_CLOSE, DEFAULT_OPEN, DEFAULT_TARGET_WAIT_SEC, draftBody, draftOperationInput, FORM_KEY, formInput, MACHINE_COUNTS, TARGET_WAIT_MINUTES, wageFloor } from '../workspace/operationInput'
import { analyzeTable, MENU_TYPES, planFrom, readTable, WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { StoreImport, Weekday } from '../workspace/storeFile'
import EasyRosterResult from './EasyRosterResult'
import type { RosterStage } from './rosterTour'
import { applyReply, chatFields, chatState, chatWorkers, editableText, mergeChanges, pushHistory, toAliases, toNames } from './easyRosterChat'
import type { ChatTurn } from './easyRosterChat'
import type { RosterConditions } from './easyRosterChat'
import { clock, noteSentences, OPTION_NAME, won } from './easyRosterModel'
import { equipmentOf, patchForm, restoreConditions, restoredDayBodies, restoredFacts } from './easyRosterRestore'
import type { RestoredFacts, StoredRequest } from './easyRosterRestore'
import { warmConditions } from './rosterWarm'
import type { WarmStage } from './rosterWarm'
import './easyRoster.css'

/*
 * 쉬운 화면의 "점심 인원"(운영 2번). 받은 가게 데이터(시연은 예시 파일) → 조건 확인(말로 고치기·고치기) →
 * 뒤에서 계산(요일마다 필요 인원 + 바쁜 시간에 1~3명 더해 보기) → 추천 근무표 3안 → 골라서 저장.
 * 단계(확인·계산·결과)는 쉬운 화면이 들고 있고(phase), 이 조각은 그 단계에 맞는 내용을 그린다.
 * 계산·저장은 운영 API를 그대로 쓴다(업무 만들기 → 조건 저장·확인 → 추천 근무표 결과 → 공통 확정).
 */

export type RosterPhase = 'start' | 'ask' | 'loading' | 'confirm' | 'running' | 'result' | 'error'
/** 이어서 연 업무나 저장한 계획. resultId가 있으면 그 결과부터 보여 준다. */
export type RosterOpened = { sessionId: number; resultId: number | null; savedChoice?: string | null; savedNote?: string; readOnly?: boolean }

// 시연용 가상 매장 데이터(마이샵에서 받을 데이터를 가정한 예시). 모양은 서울시 상권분석서비스 분기 중앙값에 맞췄다.
// 첫 단계 "어떤 데이터로 만들까요?"의 기본: 마이샵에 연결된 매출(시연에서는 연동이 없어 첫 예시 가게 데이터를 쓴다).
const MYSHOP_LABEL = '마이샵 매출 데이터'
const SAMPLES = [
  { file: 'shinhan_pattern_pos.xlsx', label: '예시 가게 (상권 평균 데이터)' },
  { file: 'busy_cafe_pos.xlsx', label: '바쁜 가게 예시 (아침·점심 모두 붐빔)' },
]
// 쉬운 화면은 버튼을 적게: 목표 대기 선택지(TARGET_WAIT_MINUTES) 중 3·5·7분만 보인다. 지금 값이 다르면 그 값도 같이 보인다.
const WAIT_CHOICES = TARGET_WAIT_MINUTES.filter((m) => m === 3 || m === 5 || m === 7)
// 시급 빠른 선택: 올해 최저시급 + 쉬운 화면 다른 업무와 같은 두 값(직접 바꾸려면 말로 고치기)
const WAGE_STEPS = [11000, 12000]
// 미리 계산: 조건이 마지막으로 바뀐 뒤 기다리는 시간, 다른 미리 계산이 돌 때 다시 묻는 간격과 횟수(한 건에 약 1분 반)
const WARM_DELAY_MS = 3000
const WARM_RETRY_MS = 10000
const WARM_RETRIES = 9
const errorText = (cause: unknown, fallback: string) => (cause instanceof Error && cause.message ? cause.message : fallback)

export default function EasyRoster({
  phase,
  onPhase,
  onSession,
  opened = null,
  onBack,
  onStage,
}: {
  phase: RosterPhase
  onPhase: (next: 'confirm' | 'running' | 'result' | 'error') => void
  /** 업무를 만들면 알린다(쉬운 화면이 주소를 이 업무로 바꿔 새로 고쳐도 다시 열리게). */
  onSession: (sessionId: number) => void
  opened?: RosterOpened | null
  /** 위 "← 이전" 줄을 이 화면 안의 한 단계(조건 확인 → 데이터 고르기)로 바꿀 때 알린다. null이면 쉬운 화면 기본. */
  onBack?: (back: { label: string; run: () => void } | null) => void
  /** 따라 하며 배우기가 데이터 고르기/조건 확인 중 어느 단계인지 알게 한다. */
  onStage?: (stage: RosterStage) => void
}) {
  const [source, setSource] = useState<{ label: string; imp: StoreImport } | null>(null)
  // 다시 불러온 업무: 저장된 계산 요청(요일별 조건·직원)으로 조건을 채우고, 원본 파일 없이 그 숫자로 다시 계산한다.
  const [restored, setRestored] = useState<{ request: StoredRequest; facts: RestoredFacts } | null>(null)
  const [aiTypes, setAiTypes] = useState<Record<string, string | null>>({})
  const [aiCount, setAiCount] = useState(0)
  const [cond, setCond] = useState<RosterConditions | null>(null)
  const [editing, setEditing] = useState(false)
  const [showTeam, setShowTeam] = useState(false) // 조건 카드: 직원별 일할 수 있는 요일·시간 펼치기
  const [changedRows, setChangedRows] = useState<string[]>([])
  const [chatText, setChatText] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  /** 지금 조건(채팅 답을 기다리는 동안 사장님이 고쳤는지 보려고). */
  const condNow = useRef<RosterConditions | null>(null)
  /** 지금까지 쓴 가장 큰 직원 번호. 뺀 직원 번호를 새 직원에게 다시 주지 않게(앞 대화의 별칭이 다른 사람을 가리키지 않게). */
  const maxPersonId = useRef(0)
  useEffect(() => {
    condNow.current = cond
    maxPersonId.current = Math.max(maxPersonId.current, ...(cond?.team.people.map((p) => p.id) ?? []))
  }, [cond])
  const [chatReply, setChatReply] = useState<{ text: string; ok: boolean } | null>(null)
  const [session, setSession] = useState<number | null>(opened?.sessionId ?? null)
  const [options, setOptions] = useState<RosterOptions | null>(null)
  const [stored, setStored] = useState<{ resultId: number; versionId: number; summary: RosterSummary } | null>(null)
  const [chosen, setChosen] = useState<OptionKey>('RECOMMENDED')
  const [saved, setSaved] = useState('')
  const [explain, setExplain] = useState<{ text: string; ai: boolean } | null>(null)
  // AI 설명: 맨 위 상자는 코드 요약으로 두고, AI 설명은 사장님이 보고 있는 채팅 칸에 띄운다(다시 계산해도 그 자리에서 보임).
  const [aiNote, setAiNote] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [seconds, setSeconds] = useState(0)
  const [progress, setProgress] = useState<RosterProgressData | null>(null) // 계산 중 끝난 요일
  const [runDays, setRunDays] = useState<string[]>([]) // 이번 계산에 보낸 요일(진행 정보가 오기 전 목록용)
  const stopRef = useRef<{ stopped: boolean } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // 새로 시작하면 먼저 데이터를 고른다(한 화면에 하나만 묻기). 이어서 열거나 다시 계산할 때는 건너뛴다.
  const [pickData, setPickData] = useState(!opened?.resultId)
  const [showSamples, setShowSamples] = useState(false)

  const imp = source?.imp ?? null
  const plan = useMemo(() => (imp ? planFrom(imp, 'AVERAGE', null, {}, 1, aiTypes) : null), [imp, aiTypes])
  const facts = restored?.facts ?? null
  const open = facts?.open ?? plan?.open ?? DEFAULT_OPEN
  const close = facts?.close ?? plan?.close ?? DEFAULT_CLOSE
  const daysWithData: Weekday[] = facts ? facts.days : plan ? WEEKDAYS.filter((w) => plan.weekdayDays[w]) : []
  // 데이터는 있지만 계산할 수 없는 요일(주문 시간이 너무 짧음 등): 고르는 목록에서 빼고 조건 카드에 이유를 보여 준다.
  const skippedDays = useMemo(
    () =>
      !imp || facts
        ? []
        : daysWithData
            .map((day) => ({ day, reason: skipReason(planFrom(imp, day, null, {}, 1, aiTypes)) }))
            .filter((s): s is { day: Weekday; reason: string } => s.reason !== null),
    // daysWithData는 imp·facts에서 나온다
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [imp, facts, aiTypes, daysWithData.join(',')],
  )
  const dataDays = daysWithData.filter((d) => !skippedDays.some((s) => s.day === d))
  // 근무표 범위: 'week' = 데이터가 있는 요일 전부, 요일 하나 = 그 요일 하루만(빠름). null이면 기본값(ROSTER_SCOPE_DEFAULT).
  const [scopePick, setScopePick] = useState<'week' | Weekday | null>(null)
  const busiestDataDay = useMemo<Weekday | null>(() => {
    // 하루 근무표 기본 요일: 주문이 가장 많은 요일(같으면 앞 요일)
    if (!imp || restored) return dataDays[0] ?? null
    let best: Weekday | null = null
    let most = -1
    for (const d of dataDays) {
      const orders = planFrom(imp, d, null, {}, 1, aiTypes).dailyOrders ?? 0
      if (orders > most) {
        most = orders
        best = d
      }
    }
    return best
    // dataDays는 imp·facts에서 나온다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imp, restored, aiTypes, dataDays.join(',')])
  const scope: 'week' | Weekday =
    scopePick && (scopePick === 'week' || dataDays.includes(scopePick))
      ? scopePick
      : ROSTER_SCOPE_DEFAULT === 'day' && busiestDataDay
        ? busiestDataDay
        : 'week'
  const stops = facts ? [] : plan ? blocking(plan) : []
  const peakNow = facts ? facts.peak : plan?.peak ?? null
  const dailyNow = facts ? facts.dailyOrders : plan?.dailyOrders ?? null
  const readOnly = Boolean(opened?.readOnly)

  // ---------------------------------------------------------------- 데이터 읽기
  /** 마지막으로 읽기 시작한 파일 번호. 앞 파일의 늦은 AI 분류가 지금 파일에 붙지 않게 한다. */
  const readSeq = useRef(0)
  /** 판매 내역 읽기. 읽었으면 true. */
  async function readFile(file: File, label: string): Promise<boolean> {
    return applyImport(async () => analyzeTable(await readTable(file), file.name), label)
  }
  /** 읽어 둔 정리 결과로 조건을 채운다. AI 메뉴 분류는 기다리지 않고 뒤에서 받는다(화면이 멈추지 않게). */
  async function applyImport(parse: () => Promise<StoreImport>, label: string): Promise<boolean> {
    setError('')
    const seq = ++readSeq.current
    try {
      const next = await parse()
      if (seq !== readSeq.current) return false
      setRestored(null)
      const first = planFrom(next)
      const days = WEEKDAYS.filter((w) => first.weekdayDays[w])
      const wage = String(cond?.wage ?? wageFloor())
      setSource({ label, imp: next })
      setAiTypes({})
      setAiCount(0)
      setCond((c) => ({
        targetWaitSec: c?.targetWaitSec ?? DEFAULT_TARGET_WAIT_SEC,
        espresso: c?.espresso ?? 1,
        blenders: c?.blenders ?? 1,
        owner: c?.owner ?? true,
        wage,
        team: exampleTeam(wage, first.open ?? DEFAULT_OPEN, first.close ?? DEFAULT_CLOSE, days.filter((d) => d !== 'SAT' && d !== 'SUN')),
      }))
      setChangedRows([])
      // 이름만으로 모른 메뉴만 AI에 종류를 묻는다(이름과 종류 목록만 보냄). 답이 오기 전에는 가장 많이 팔린 종류로 둔다.
      const unknown = first.menus.filter((m) => m.how === 'GUESS').map((m) => m.name).slice(0, 40)
      if (unknown.length) void classifyInBackground(unknown, seq)
      return true
    } catch (cause) {
      if (seq === readSeq.current) setError(errorText(cause, '가게 데이터를 읽지 못했어요.'))
      return false
    }
  }
  /** 같은 메뉴 이름 묶음은 AI에 한 번만 묻는다(같은 예시를 다시 골라도 토큰을 또 쓰지 않게). */
  const classified = useRef(new Map<string, Record<string, string | null>>())
  async function classifyInBackground(names: string[], seq: number) {
    const key = names.join('\n')
    let picked = classified.current.get(key)
    if (!picked) {
      // 실패해도(키 없음·연결 끊김) 기본 분류 그대로 계속한다.
      const response = await classifyMenuTypes({ names, types: MENU_TYPES }).catch(() => null)
      if (response?.status !== 'ok' || response.data?.source !== 'LLM') return
      picked = Object.fromEntries(
        Object.entries(response.data.types)
          .filter(([, v]) => v !== null)
          .map(([k, v]) => [k, v === 'FOOD' ? null : v]),
      ) as Record<string, string | null>
      classified.current.set(key, picked)
    }
    if (seq !== readSeq.current || !mounted.current) return // 그사이 다른 파일을 골랐거나 화면을 떠남
    setAiTypes(picked)
    setAiCount(Object.keys(picked).length)
  }
  /** 예시 파일은 한 번만 받아 정리해 둔다(처음 화면에서 미리 읽어 두므로 버튼을 누르면 바로 넘어간다). */
  const parsedSamples = useRef(new Map<string, Promise<StoreImport>>())
  async function readSample(file: string, label: string): Promise<boolean> {
    let job = parsedSamples.current.get(file)
    if (!job) {
      job = (async () => {
        const response = await fetch(`/samples/${file}`)
        if (!response.ok) throw new Error('예시 가게 데이터를 불러오지 못했어요.')
        return analyzeTable(await readTable(new File([await response.blob()], file)), file)
      })()
      parsedSamples.current.set(file, job)
      job.catch(() => parsedSamples.current.delete(file)) // 실패하면 다음에 다시 받는다
    }
    const pending = job
    return applyImport(() => pending, label)
  }
  /** 첫 단계에서 고른 데이터로 조건 확인 카드로 넘어간다. */
  async function chooseData(read: () => Promise<boolean>) {
    if (await read()) {
      setPickData(false)
      setShowSamples(false)
    }
  }

  // 처음: 저장된 결과가 있으면 그 결과부터(예시 파일을 읽고 AI 메뉴 분류를 기다리지 않고 바로 연다).
  // 저장된 조건으로 다시 불러오지 못한 예전 결과만, 결과를 띄운 뒤 예시 가게 데이터를 읽어 둔다("조건 다시 보기"용).
  // 결과가 없으면 예시 가게 데이터로 조건 확인부터.
  const started = useRef(false)
  // 화면에 붙어 있는지. 처음 읽기가 끝나기 전에 다른 화면으로 가면 부모 단계를 바꾸지 않는다.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // 계산을 기다리던 중에 다른 업무를 열면 기다리기를 멈춘다. 안 멈추면 끝난 뒤 새로 연 화면의 단계를 "결과"로 바꿔 빈 화면이 된다.
      if (stopRef.current) stopRef.current.stopped = true
    }
  }, [])
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      if (opened?.resultId) {
        const back = await showSaved(opened.resultId)
        // 불러오기 자체가 실패했으면 예시 데이터로 채우지 않는다("다시 시도"가 같은 결과를 다시 불러온다).
        if (back === 'shown' && !opened.readOnly) await readSample(SAMPLES[0].file, MYSHOP_LABEL)
        return
      }
      // 읽기 번호는 applyImport가 바로(기다리기 전에) 하나 올린다. 끝났을 때 번호가 그대로면 이 읽기가 마지막이다.
      // 마지막이면 성공이든 실패든 조건 확인 단계로(실패면 데이터 고르기 화면에 오류와 다시 고르기가 보인다).
      // 그사이 사장님이 다른 파일을 골라 이 읽기가 버려졌으면 단계를 건드리지 않는다(계산 중 화면을 되돌리지 않게).
      const mine = readSeq.current + 1
      await readSample(SAMPLES[0].file, MYSHOP_LABEL)
      if (readSeq.current === mine && mounted.current) onPhase('confirm')
    })()
    // 처음 한 번만. 다른 업무를 열면 쉬운 화면이 이 조각을 새로 만든다(key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 저장된 결과를 못 불러왔을 때 그 결과 번호("다시 시도"가 같은 결과를 다시 부른다). */
  const [savedFailed, setSavedFailed] = useState<number | null>(null)
  /** 저장된 결과 열기. restored: 저장된 조건까지 다시 불러옴, shown: 결과만 보여 줌, failed: 불러오지 못함. */
  async function showSaved(resultId: number): Promise<'restored' | 'shown' | 'failed'> {
    const phaseTo = (next: Parameters<typeof onPhase>[0]) => {
      if (mounted.current) onPhase(next)
    }
    setSavedFailed(null)
    try {
      const detail = await loadRosterResult(resultId)
      if (detail.status !== 'ok' || !detail.data) throw new Error(detail.message ?? '근무표를 불러오지 못했어요.')
      const data = detail.data as StoredRosterResult
      if (data.summary?.result_kind !== 'ROSTER_OPTIONS') {
        setLegacy(true)
        phaseTo('result')
        return 'shown'
      }
      show(data)
      // 다시 불러오기: 그때의 조건·직원으로 채운다(저장한 계획 보기는 고칠 수 없어 건너뜀).
      const back = data.detail?.request ? restoredFacts(data.detail.request) : null
      if (back && !opened?.readOnly) {
        setRestored({ request: data.detail.request, facts: back })
        setCond(restoreConditions(data.detail.request, { open: back.open, close: back.close }))
      }
      const choice = (opened?.savedChoice ?? data.confirmed_choice_key ?? null) as OptionKey | null
      if (choice) {
        setChosen(choice)
        setSaved(opened?.savedNote ?? `${OPTION_NAME[choice]}로 저장한 업무예요`)
      }
      phaseTo('result')
      return back && !opened?.readOnly ? 'restored' : 'shown'
    } catch (cause) {
      setError(errorText(cause, '근무표를 불러오지 못했어요.'))
      setSavedFailed(resultId)
      phaseTo('error')
      return 'failed'
    }
  }

  /** 세 근무표의 주 인건비와 요일별 가장 긴 대기가 모두 같으면 같은 결과로 본다. */
  function sameOutcome(a: RosterOptions, b: RosterOptions) {
    // 안은 key로, 요일은 요일 이름으로 짝지어 비교한다(배열·객체 순서가 달라도 같은 결과면 같다고 본다).
    if (a.options.length !== b.options.length) return false
    return a.options.every((x) => {
      const y = b.options.find((o) => o.key === x.key)
      if (!y || x.plan_cost_krw !== y.plan_cost_krw) return false
      const days = new Set([...Object.keys(x.peak_wait_sec ?? {}), ...Object.keys(y.peak_wait_sec ?? {})])
      return [...days].every((d) => (x.peak_wait_sec?.[d] ?? null) === (y.peak_wait_sec?.[d] ?? null))
    })
  }

  function show(data: StoredRosterResult) {
    const next = optionsFromStored(data)
    setOptions(next)
    setStored({ resultId: data.result_id, versionId: data.input_version_id, summary: data.summary })
    setChosen(data.summary.recommended_choice_key ?? 'RECOMMENDED')
    void explainResult(next, data.summary)
  }

  /** 설명 요청 번호. 새 결과가 뜨면 늘어나, 앞 결과의 늦은 설명은 화면·대화 기록에 넣지 않는다. */
  const explainSeq = useRef(0)
  async function explainResult(data: RosterOptions, summary: RosterSummary) {
    const fallback = summary.message
    const seq = ++explainSeq.current
    setExplain({ text: fallback, ai: false })
    setAiNote(null)
    try {
      const response = await rosterExplain({ result: rosterDigest(data), fallback })
      if (seq !== explainSeq.current) return
      if (response.status === 'ok' && response.data?.source === 'LLM') {
        const text = response.data.text
        setAiNote(text)
        // "왜 그래?"처럼 설명을 이어 물으면 AI가 무엇을 가리키는지 알 수 있게 대화 기록에도 넣는다.
        chatHistory.current = pushHistory(chatHistory.current, { role: 'assistant', text })
      }
    } catch {
      // 설명을 못 받아도 코드 요약 문장은 이미 보인다.
    }
  }

  // ---------------------------------------------------------------- 계산
  const equipment = equipmentOf

  /** 계산에 보낼 요일별 조건·직원 명단. 진짜 계산과 미리 계산이 같은 값을 보내야 서버의 요일 기억을 같이 쓴다. */
  function rosterBody(c: RosterConditions): JsonObject {
    const people = { isOwnerWorking: c.owner, hourlyWage: Number(c.wage) }
    const days =
      restored || !imp
        ? restoredDayBodies((restored as { request: StoredRequest }).request, c)
        : rosterDays(
            dataDays,
            (day) => planFrom(imp, day, null, {}, 1, aiTypes),
            (p) => draftBody(formFromPlan(imp, p, people, equipment(c))),
            c.owner,
            c.team,
          ).days
    // 하루 근무표면 그 요일만 보낸다(서버는 요일 1~7개를 같은 방식으로 계산한다).
    const picked = scope === 'week' ? days : days.filter((d) => (d as { day?: string }).day === scope)
    // 쉬운 화면은 주휴 비교를 보여 주지 않으므로 계산하지 않는다(요일마다 근무표 하나를 덜 짜서 빨라진다).
    return { days: picked, workers: rosterWorkers(c.team.people), compare_holiday_pay: false }
  }

  // ---------------------------------------------------------------- 미리 계산(E·G)
  // 서버가 미리 계산해 두면(저장 없음) "만들기"·말로 고치기를 할 때 끝난 요일은 바로, 도는 요일은 이어받는다.
  // - 조건 확인 카드(E): 지금 조건. 고치는 중에는 보내지 않고, 마지막으로 바뀐 뒤 WARM_DELAY_MS가 지나야 보낸다.
  // - 결과 화면(G): 목표 대기의 다른 값(3·5·7분)을 하나씩 차례로. 서버는 미리 계산을 한 번에 1건만 받아서
  //   앞 계산이 도는 동안은 WARM_RETRY_MS마다 다시 묻는다. 진짜 계산이 돌면 서버가 건너뛰고 여기서도 멈춘다.
  const warmSent = useRef(new Set<string>())
  const warmStage: WarmStage | null =
    readOnly || !cond || stops.length || !(restored || (imp && plan))
      ? null
      : phase === 'confirm' && !editing && !pickData
        ? 'confirm'
        : phase === 'result' && options && !legacy
          ? 'result'
          : null
  const warmBodies = useMemo(() => {
    if (!warmStage || !cond) return []
    try {
      return warmConditions(warmStage, cond, WAIT_CHOICES)
        .map((c) => rosterBody(c))
        .filter((b) => (b.days as JsonObject[]).length)
    } catch {
      return []
    }
    // rosterBody는 아래 값들로만 정해진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [warmStage, cond, restored, imp, aiTypes, scope])
  useEffect(() => {
    const queue = warmBodies.map((body) => ({ body, signature: JSON.stringify(body) })).filter((w) => !warmSent.current.has(w.signature))
    if (!queue.length) return
    let timer = 0
    let stopped = false
    let tries = 0
    const send = async () => {
      const next = queue[0]
      if (stopped || !next) return
      tries += 1
      try {
        const answer = await warmRoster(next.body)
        if (stopped) return
        if (answer.data?.state === 'STARTED') {
          warmSent.current.add(next.signature)
          queue.shift()
          tries = 0
          if (queue.length) timer = window.setTimeout(send, WARM_RETRY_MS)
        } else if (answer.data?.reason === 'WARM_RUNNING' && tries < WARM_RETRIES) {
          // 앞 미리 계산이 아직 도는 중: 조금 뒤 다시
          timer = window.setTimeout(send, WARM_RETRY_MS)
        }
        // REAL_RUNNING(진짜 계산 중)·INVALID면 멈춘다.
      } catch {
        // 미리 계산은 실패해도 진짜 계산에 영향이 없다.
      }
    }
    timer = window.setTimeout(send, WARM_DELAY_MS)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [warmBodies])

  async function run(c: RosterConditions | null = cond) {
    if (!c || stops.length || (!restored && (!imp || !plan))) return
    const before = options
    const people = { isOwnerWorking: c.owner, hourlyWage: Number(c.wage) }
    const form = !restored && imp && plan ? formFromPlan(imp, plan, people, equipment(c)) : null
    const stop = { stopped: false }
    stopRef.current = stop
    setError('')
    setSaved('')
    setSeconds(0)
    setProgress(null)
    setChatReply(null)
    onPhase('running')
    try {
      // 보낼 요일이 없으면 업무에 조건 버전을 남기기 전에 멈춘다(빈 버전이 쌓이지 않게).
      const body = rosterBody(c)
      if (!(body.days as JsonObject[]).length) throw new Error('근무표를 만들 요일 데이터가 없어요.')
      setRunDays((body.days as JsonObject[]).map((d) => String(d.day)))
      if (form) await draftOperationInput(form)
      let sessionId = session
      if (!sessionId) {
        // 제목에 어떤 데이터로 만들었는지 붙여 "하던 일" 목록에서 같은 제목이 줄줄이 나오지 않게 한다.
        const from = source ? source.label.replace(/\s*\(.*\)$/, '').replace(/^내 판매 내역$/, source.label.match(/\((.*)\)$/)?.[1] ?? '내 판매 내역') : ''
        const created = await workflowApi.create(Number(import.meta.env.VITE_STORE_ID ?? 1), 'operation', 'form', `[쉬운 화면] 추천 근무표${from ? ` · ${from}` : ''}`)
        sessionId = created.session_id
        if (!mounted.current) return // 만드는 사이 화면을 떠났으면 부모 상태를 바꾸지 않는다
        setSession(sessionId)
        onSession(sessionId)
      }
      // 조건은 업무에 새 버전으로 남긴다(다시 계산하면 같은 업무 안에서 버전이 쌓인다).
      const context = await workflowApi.context(sessionId)
      // 다시 불러온 업무는 원본 파일이 없어서, 업무에 저장된 마지막 조건에 지금 값만 덮어 새 버전으로 남긴다.
      const lastForm = (context.current_input?.[FORM_KEY] ?? {}) as JsonObject
      const input = form ? formInput(form) : { [FORM_KEY]: { ...patchForm(lastForm, c), is_owner_working: c.owner } }
      const event = await workflowApi.event(sessionId, { event_type: 'form', form_input: input, base_version_id: context.current_version_id }, crypto.randomUUID())
      const data = event.data as JsonObject | null
      const versionId = Number(data?.input_version_id)
      const versionNo = Number(data?.version_no)
      if (!versionId || !versionNo) throw new Error('조건을 저장하지 못했어요.')
      await workflowApi.confirmInput(versionId, versionNo)
      const key = crypto.randomUUID()
      const begun = await startRosterResult(sessionId, { input_version_id: versionId, ...body }, key)
      if (begun.status !== 'ok' || !begun.data) throw new Error(begun.message ?? '계산을 시작하지 못했어요.')
      const job = begun.data.state === 'DONE' ? begun.data : await waitRoster({ sessionId, versionId, key }, setSeconds, stop, setProgress)
      if (!job || stop.stopped) return
      if (!job.result_id) throw new Error('추천 근무표를 만들지 못했어요.')
      const detail = await loadRosterResult(job.result_id)
      if (detail.status !== 'ok' || !detail.data) throw new Error(detail.message ?? '근무표를 불러오지 못했어요.')
      if (stop.stopped) return
      show(detail.data)
      // 말로 바꿔 다시 계산했는데 세 근무표의 인건비·대기가 그대로면 그렇다고 알려 준다(바꾼 게 반영 안 된 걸로 보이지 않게).
      const change = nextChange.current
      const same = change && before && sameOutcome(before, optionsFromStored(detail.data))
      setLastChange(change && same ? { ...change, text: `${change.text} · 결과는 이전과 같아요(이 조건은 이번 근무표를 바꾸지 않았어요)` } : change) // 말로 바꿔 다시 계산한 게 아니면 지운다
      nextChange.current = null
      onPhase('result')
    } catch (cause) {
      if (stop.stopped) return
      setError(errorText(cause, '계산을 마치지 못했어요.'))
      onPhase('error')
    }
  }

  // 쉬운 화면에서 "계산 그만두기"를 누르면 단계가 바뀐다 → 기다리기만 멈춘다(서버 계산은 끝나면 업무에 남는다).
  useEffect(() => {
    if (phase !== 'running' && stopRef.current) stopRef.current.stopped = true
  }, [phase])

  async function save(key: OptionKey, acks: string[]) {
    if (!stored) return
    await workflowApi.confirm(stored.resultId, stored.versionId, key, acks, crypto.randomUUID())
    setSaved(`${OPTION_NAME[key]}를 저장했어요. "저장한 계획"에서 다시 볼 수 있어요.`)
  }

  // ---------------------------------------------------------------- 말로 고치기
  const rerunNext = useRef(false)
  const chatHistory = useRef<ChatTurn[]>([]) // 바로 앞 대화(별칭). 새로 고침하면 비운다.
  const [rerunNote, setRerunNote] = useState('') // 말로 바꿔 다시 계산할 때 계산 화면에 보일 문장
  // 결과를 보다가 말로 바꾼 것: 바로 계산하지 않고 모아 두었다가 사장님이 "다시 계산하기"를 누를 때 한 번에 계산한다.
  // before = 처음 바꾸기 전 조건("취소"하면 이리로 되돌린다), changes = 바꾼 내용 답장들.
  const [pending, setPending] = useState<{ before: RosterConditions; changes: string[] } | null>(null)
  const chatInput = useRef<HTMLTextAreaElement>(null)

  /** 말로 바꿔 다시 계산하면 결과 위에 무엇을 바꿨는지, 말로 새로 넣은 직원이 누구인지 보여 준다. */
  const [lastChange, setLastChange] = useState<{ text: string; added: string[] } | null>(null)
  const nextChange = useRef<{ text: string; added: string[] } | null>(null)
  const changeOf = (p: { before: RosterConditions; changes: string[] }) => {
    const before = new Set(p.before.team.people.map((x) => x.id))
    return { text: p.changes.join(' · '), added: (cond?.team.people ?? []).filter((x) => !before.has(x.id)).map((x) => x.name) }
  }
  function rerunPending() {
    if (!pending) return
    nextChange.current = changeOf(pending)
    setRerunNote(`${pending.changes.join(' ')} 이 조건으로 다시 계산하고 있어요.`)
    setPending(null)
    setChatReply(null)
    void run()
  }

  function cancelPending() {
    if (!pending) return
    setCond(pending.before)
    setPending(null)
    setChatReply({ text: '바꾼 내용을 되돌렸어요. 근무표는 그대로예요.', ok: false })
  }
  useEffect(() => {
    if (phase === 'result' || phase === 'error') setRerunNote('') // 계산이 끝나면 지운다(답장은 대화 칸에 남는다)
  }, [phase])

  // "← 이전" 한 단계: 이 화면에서 데이터를 골라 조건 확인으로 왔으면 데이터 고르기로 돌아간다(홈으로 가지 않게).
  // 이어서 연 업무(지난번 조건)·저장한 계획·계산 중·결과는 쉬운 화면 기본 동작 그대로.
  const backToData = phase === 'confirm' && !pickData && !readOnly && Boolean(source) && !restored
  useEffect(() => {
    onBack?.(backToData ? { label: '데이터 다시 고르기', run: () => { setEditing(false); setPickData(true) } } : null)
  }, [backToData, onBack])
  useEffect(() => () => onBack?.(null), [onBack])
  const stage: RosterStage = phase === 'confirm' && !readOnly ? (pickData ? 'pick' : 'confirm') : null
  useEffect(() => {
    onStage?.(stage)
  }, [stage, onStage])
  useEffect(() => () => onStage?.(null), [onStage])
  useEffect(() => {
    if (!rerunNext.current) return
    rerunNext.current = false
    void run()
  })

  async function sendChat(event: FormEvent) {
    event.preventDefault()
    const message = chatText.trim()
    if (!message || !cond || chatBusy) return
    setChatBusy(true)
    setChatReply(null)
    const aliased = toAliases(message, cond.team.people)
    try {
      const response = await rosterChat({
        // 직원 이름은 별칭으로 바꿔 보내고(AI에 이름이 가지 않게), 답장은 다시 이름으로 바꿔 보여 준다.
        message: aliased,
        history: chatHistory.current,
        fields: chatFields(open, close, dataDays),
        state: chatState(cond, { open, close, busy: peakNow ? `${peakNow.start}~${peakNow.end}` : null, dailyOrders: dailyNow }),
        workers: chatWorkers(cond.team.people),
        ...(options ? { result: rosterDigest(options) } : {}),
      })
      if (response.status !== 'ok' || !response.data) throw new Error(response.message ?? '말을 처리하지 못했어요.')
      const reply = response.data
      if (condNow.current !== cond && (reply.changes.length || reply.worker_changes.length)) {
        // 보낸 뒤 조건 화면에서 직접 고쳤으면, 옛 조건 기준 답으로 덮어쓰지 않는다.
        setChatReply({ text: '말을 보내는 동안 조건이 바뀌어 반영하지 않았어요. 한 번 더 말해 주세요.', ok: false })
        return
      }
      const applied = applyReply(cond, reply, { open, close, nextId: maxPersonId.current + 1 })
      setChatText('')
      chatHistory.current = pushHistory(chatHistory.current, { role: 'owner', text: aliased }, { role: 'assistant', text: reply.reply })
      // 사장님 시간처럼 합쳐 보니 앞뒤가 안 맞아 되돌린 변경이 있으면 그 이유를 보여 준다.
      // 다른 변경은 반영됐으면(부분 반영) 답장과 이유를 같이, 모두 되돌렸으면 이유만.
      const answer = toNames(reply.reply, cond.team.people)
      const shown = applied.rejected ? (applied.changed ? `${answer} 단, ${applied.rejected}` : applied.rejected) : answer
      setChatReply({ text: shown, ok: applied.changed })
      // 이번 말로 바꾼 것까지 합친 "모아 둔 변경"(바로 아래 setPending은 다음 렌더에야 보이므로 여기서 같이 계산해 둔다).
      let pendingNow = pending
      if (applied.changed) {
        setCond(applied.next)
        setChangedRows(applied.rows)
        // 결과를 보고 있었으면 바로 계산하지 않고, 바꾼 내용을 보여 주고 "다시 계산할까요?"를 묻는다(더 고칠 수도 있게).
        if (phase === 'result') {
          // 제목이 이미 "이렇게 바꿨어요"라 앞말은 뺀다. 같은 칸을 또 바꾸면(시급 11,000 → 10,320) 마지막 값만 남긴다.
          pendingNow = { before: pending?.before ?? cond, changes: mergeChanges(pending?.changes ?? [], shown.replace(/^바꿨어요 — /, '')) }
          setPending(pendingNow)
          setChatReply(null)
          // AI가 "그럼 계산해 줘", "응"을 알아듣게, 화면이 물은 말도 앞 대화에 넣는다.
          chatHistory.current = pushHistory(chatHistory.current, { role: 'assistant', text: '바꾼 조건으로 아직 다시 계산하지 않았어요. 이대로 다시 계산할까요?' })
        }
      }
      // "다시 계산해 줘"처럼 계산해 달라고 직접 말했을 때만 바로 계산한다(모아 둔 변경이 있으면 같이).
      if (reply.intent === 'RUN' && (phase === 'result' || phase === 'confirm')) {
        nextChange.current = pendingNow ? changeOf(pendingNow) : null
        setRerunNote(pendingNow ? `${pendingNow.changes.join(' ')} 이 조건으로 다시 계산하고 있어요.` : shown)
        setPending(null)
        rerunNext.current = true
      }
    } catch (cause) {
      setChatReply({ text: errorText(cause, '말을 처리하지 못했어요.'), ok: false })
    } finally {
      setChatBusy(false)
    }
  }

  const chatBox = (
    <section className="easy-card er-chat easy-noprint">
      <h2>{phase === 'result' ? '바꾸거나 묻고 싶은 게 있으세요?' : '말로 고치기'}</h2>
      <form className="easy-input" onSubmit={sendChat}>
        <label htmlFor="er-chat" className="easy-sr">말로 고치기</label>
        <textarea
          id="er-chat"
          ref={chatInput}
          rows={2}
          maxLength={300}
          value={chatText}
          placeholder={phase === 'result' ? '예: 금요일엔 제가 가게에 못 나가요' : '예: 손님 3분 넘게 안 기다리게 해 줘'}
          disabled={chatBusy}
          onChange={(e) => setChatText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              e.currentTarget.form?.requestSubmit()
            }
          }}
        />
        <button type="submit" className="easy-primary" disabled={chatBusy || !chatText.trim()}>{chatBusy ? '보내는 중' : '보내기'}</button>
      </form>
      {phase === 'result' && pending && (
        <div className="er-pending" role="status">
          <p className="er-pending-title">이렇게 바꿨어요. 아직 근무표에는 반영 안 했어요.</p>
          <ul>
            {pending.changes.map((text, i) => (
              <li key={i}>{text}</li>
            ))}
          </ul>
          <p>이 조건으로 다시 계산할까요? 더 고칠 게 있으면 위 칸에 이어서 말해 주세요.</p>
          <div className="easy-actions">
            <button type="button" className="easy-primary" disabled={chatBusy} onClick={rerunPending}>다시 계산하기</button>
            <button type="button" className="easy-secondary" onClick={() => chatInput.current?.focus()}>더 고칠게요</button>
            <button type="button" className="easy-secondary" onClick={cancelPending}>취소</button>
          </div>
        </div>
      )}
      {phase === 'result' && aiNote && (
        <div className="er-reply er-ai-note" role="status">
          <b>AI 설명</b>
          <ul>
            {noteSentences(aiNote).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {chatReply && (
        <p className={`er-reply${chatReply.ok ? ' ok' : ''}`} role="status">
          {chatReply.ok && <i aria-hidden>✓ </i>}
          {chatReply.text}
        </p>
      )}
      <p className="easy-muted er-small er-editable">
        <b>말로 바꿀 수 있어요:</b> {editableText(chatFields(open, close, dataDays))}. 결과나 조건을 물어봐도 돼요.
      </p>
      <p className="easy-muted er-small">AI가 고칠 칸을 고르면, 값이 허용 범위 안인지 다시 확인한 뒤에만 반영해요.</p>
    </section>
  )

  // ---------------------------------------------------------------- 그리기
  if (phase === 'loading' || phase === 'start' || phase === 'ask') return null

  if (phase === 'running')
    return (
      <div className="easy-running er-running" role="status">
        <div className="er-running-top">
          <span className="easy-spinner" aria-hidden />
          <span>
            {rerunNote && <strong className="er-rerun-note">{rerunNote}</strong>}
            요일마다 사람을 한 명씩 늘려 보며 대기 시간을 재는 중이에요{seconds ? ` (${seconds}초)` : ''}
            <small className="er-running-note">창을 닫아도 계산은 계속돼요. "하던 일 이어하기"에서 다시 열 수 있어요.</small>
          </span>
        </div>
        <RosterProgress progress={progress} days={runDays} />
      </div>
    )

  if (phase === 'error')
    return (
      <Card title="잠깐 연결이 안 됐어요">
        <p>{error || '계산을 마치지 못했어요.'}</p>
        <p className="easy-muted">조건은 그대로예요. 잠시 뒤 "다시 시도"를 눌러 주세요.</p>
        <div className="easy-actions">
          {savedFailed !== null ? (
            <button type="button" className="easy-primary" onClick={() => void showSaved(savedFailed)}>다시 시도</button>
          ) : (
            !readOnly && cond && <button type="button" className="easy-primary" onClick={() => void run()}>다시 시도</button>
          )}
          {!readOnly && cond && <button type="button" className="easy-secondary" onClick={() => onPhase('confirm')}>조건 다시 보기</button>}
        </div>
      </Card>
    )

  if (phase === 'result') {
    if (legacy)
      return (
        <Card title="예전 방식으로 계산한 업무예요">
          <p>세 운영안 비교로 계산한 결과라 이 화면에서는 볼 수 없어요. 예전 업무 화면에서 열어 주세요.</p>
          <div className="easy-actions">
            <a className="easy-secondary er-link" href={`?mode=classic#/work`}>예전 업무 화면 열기</a>
          </div>
        </Card>
      )
    if (!options) return null
    return (
      <EasyRosterResult
        resultId={stored?.resultId ?? null}
        data={options}
        summary={stored?.summary ?? null}
        chosen={chosen}
        onChoose={setChosen}
        explain={explain}
        saved={saved}
        readOnly={readOnly}
        onSave={save}
        chat={chatBox}
        changed={lastChange}
      />
    )
  }

  // 파일 고르기 창(첫 단계와 고치기에서 같이 쓴다)
  const fileInput = (
    <input
      ref={fileRef}
      type="file"
      accept=".xlsx,.csv"
      hidden
      onChange={(e) => {
        const file = e.target.files?.[0]
        if (file) void chooseData(() => readFile(file, `내 판매 내역 (${file.name})`))
        e.target.value = ''
      }}
    />
  )
  if (pickData)
    return (
      <Card title="어떤 데이터로 근무표를 만들까요?" tour="source">
        {fileInput}
        {/* 하던 일에서 연 업무인데 결과가 없음: 계산이 끝나야 데이터·직원 명단이 결과와 함께 저장되므로 다시 고르게 안내한다 */}
        {opened?.sessionId != null && !opened.resultId && (
          <p className="easy-muted" role="status">
            계산이 끝나기 전에 나간 업무예요. 서버 계산이 끝났다면 "하던 일"에서 다시 열면 결과가 보여요. 아니면 데이터를 다시 골라 주세요. 이 업무에 이어서 계산해요.
          </p>
        )}
        <div className="er-source">
          <button type="button" className="er-source-main" onClick={() => void chooseData(() => readSample(SAMPLES[0].file, MYSHOP_LABEL))}>
            <span aria-hidden>🔗</span>
            <span>
              <b>
                마이샵 매출 데이터로 만들기 <em className="er-badge-inline">추천</em>
              </b>
              <small>연결된 카드 매출로 바로 계산해요 · 시연은 예시 데이터</small>
            </span>
            <i aria-hidden>›</i>
          </button>
          <button type="button" onClick={() => fileRef.current?.click()}>
            <span aria-hidden>📁</span>
            <span>
              <b>내 판매 내역 파일 올리기</b>
              <small>포스기에서 받은 엑셀·CSV</small>
            </span>
            <i aria-hidden>›</i>
          </button>
          <button type="button" aria-expanded={showSamples} onClick={() => setShowSamples((v) => !v)}>
            <span aria-hidden>🧪</span>
            <span>
              <b>예시 가게로 먼저 해 보기</b>
              <small>내 데이터 없이 체험해요</small>
            </span>
            <i aria-hidden>{showSamples ? '⌄' : '›'}</i>
          </button>
          {showSamples && (
            <div className="easy-pick er-source-samples" role="group" aria-label="예시 가게">
              {SAMPLES.map((s) => (
                <button key={s.file} type="button" onClick={() => void chooseData(() => readSample(s.file, s.label))}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
        </div>
        <p className="easy-muted er-source-note">파일은 이 브라우저 안에서만 읽고, 시간대별 주문 수 같은 정리한 숫자만 저장해요.</p>
        {error && <p className="easy-error">{error}</p>}
      </Card>
    )
  // 조건 확인
  if (!cond || (!plan && !facts))
    return error ? (
      <Card title="가게 데이터를 읽지 못했어요">
        <p>{error}</p>
      </Card>
    ) : null
  const row = (key: string) => (changedRows.includes(key) ? 'er-changed' : undefined)
  const ownerText = cond.owner
    ? `${cond.team.ownerDays.map((d) => WEEKDAY_LABEL[d]).join('·') || '근무 요일 없음'} · ${clock(cond.team.ownerStart)} ~ ${clock(cond.team.ownerEnd)}`
    : '매장에서 일하지 않아요'
  const withCurrent = (list: number[], v: number) => [...new Set([...list, v])].sort((a, b) => a - b)
  const wageNumber = Number(cond.wage)
  const sourceTag = facts ? '지난번 조건' : source?.label === MYSHOP_LABEL ? '마이샵' : source?.label.startsWith('내 판매 내역') ? '내 파일' : '예시'
  return (
    // 조건 카드와 아래 말로 고치기 칸을 한 묶음으로(따라 하며 배우기 3단계가 둘을 같이 비춘다)
    <div data-tour="confirm-area">
      {fileInput}
      <Card title="이 조건이 맞나요?" tour="confirm">
        <ul className="easy-facts er-facts">
          <li>
            <span>
              가게 데이터 <em className="er-tag">{sourceTag}</em>
            </span>
            <b>
              {facts ? `지난번에 쓴 데이터${facts.dataDays ? ` · ${facts.dataDays}일치 판매 내역` : ''}` : `${source?.label} · ${plan?.days ?? 0}일치 판매 내역`}
            </b>
          </li>
          <li>
            <span>영업 시간</span>
            <b>{clock(open)} ~ {clock(close)}</b>
          </li>
          <li>
            <span>하루 주문 <em className="er-tag">데이터</em></span>
            <b>평균 약 {dailyNow ?? 0}건</b>
          </li>
          <li>
            <span>바쁜 시간 <em className="er-tag">자동으로 찾음</em></span>
            <b>{peakNow ? `${clock(peakNow.start)} ~ ${clock(peakNow.end)}` : '찾지 못했어요'}{' · 요일마다 다시 찾고, 아침처럼 붐비는 때가 더 있으면 함께 봐요'}</b>
          </li>
          <li className={row('owner')}>
            <span>사장님 근무</span>
            <b>{ownerText}</b>
          </li>
          <li className={row('team')}>
            <span>직원 명단</span>
            <b>
              {cond.team.people.length}명 {facts ? '(지난번 명단)' : '(예시 명단)'}{' '}
              <button type="button" className="er-more" onClick={() => setShowTeam(!showTeam)}>
                {showTeam ? '접기' : '누가 언제 되는지 보기'}
              </button>
            </b>
          </li>
          {showTeam && (
            // 근무표는 직원마다 일할 수 있는 요일·시간 안에서만 짠다(모든 날 다 되는 게 아니다). 그 가정을 그대로 보여 준다.
            <li className="er-team">
              <ul>
                {cond.team.people.map((p) => (
                  <li key={p.id}>
                    <b>{p.name}</b> {p.days.length ? p.days.map((d) => WEEKDAY_LABEL[d]).join('·') : '요일 없음'} · {clock(p.start)} ~ {clock(p.end)} · 주 최대 {p.maxHours}시간
                    {p.minor ? ' · 미성년' : ''}
                  </li>
                ))}
              </ul>
              <small>직원마다 일할 수 있다고 한 요일·시간이에요. 근무표는 모두 주 15시간 미만으로 짜요.</small>
            </li>
          )}
          <li className={row('target')}>
            <span>목표 대기</span>
            <b>{cond.targetWaitSec / 60}분 안 (손님 10명 중 9명)</b>
          </li>
          <li className={row('machines')}>
            <span>기계</span>
            <b>에스프레소 머신 {cond.espresso}대 · 블렌더 {cond.blenders}대</b>
          </li>
          <li>
            <span>근무표 범위</span>
            <b>{scope === 'week' ? `일주일 (${dataDays.map((d) => WEEKDAY_LABEL[d]).join('·')})` : `${WEEKDAY_LABEL[scope]}요일 하루만 (빨라요)`}</b>
          </li>
          <li className={row('wage')}>
            <span>직원 시급 · 규칙</span>
            <b>{won(wageNumber)} · 주 15시간 미만 · 휴게 포함</b>
          </li>
        </ul>
        {facts && <p className="easy-muted er-small">지난번에 저장한 조건과 직원 명단을 그대로 불러왔어요. 고친 뒤 다시 계산하면 같은 업무에 새로 저장돼요.</p>}
        {!facts && aiCount > 0 && <p className="easy-muted er-small">메뉴 이름만으로 모른 {aiCount}개는 AI가 음료 종류를 골랐어요.</p>}
        {!facts && imp && imp.sameRows > 0 && (
          <p className="easy-muted er-small">
            파일에 날짜·시각·메뉴까지 똑같은 줄이 {imp.sameRows}건 있어요. 같은 분에 온 다른 손님일 수 있어 모두 셌어요. 같은 파일을 두 번
            받으셨다면 확인해 주세요.
          </p>
        )}
        {stops.length > 0 && <p className="easy-error">{stops[0]}</p>}
        {stops.length === 0 && skippedDays.length > 0 && (
          <p className="easy-muted er-small" role="status">
            이 요일은 빼고 계산해요: {skippedDays.map((s) => `${WEEKDAY_LABEL[s.day]}요일(${s.reason})`).join(', ')}
          </p>
        )}
        {editing && (
          <div className="easy-edit">
            {dataDays.length > 1 && (
              // 일주일이 오래 걸릴 때 하루만 먼저: 서버가 요일 하나만 계산해서 빠르다(멘토링 대안).
              <Pick
                label="근무표 범위"
                value={scope === 'week' ? -1 : dataDays.indexOf(scope)}
                options={[-1, ...dataDays.map((_, i) => i)]}
                format={(i) => (i < 0 ? '일주일' : `${WEEKDAY_LABEL[dataDays[i]]}요일 하루만`)}
                onPick={(i) => setScopePick(i < 0 ? 'week' : dataDays[i])}
              />
            )}
            <Pick label="목표 대기" value={cond.targetWaitSec / 60} options={withCurrent(WAIT_CHOICES, cond.targetWaitSec / 60)} format={(v) => `${v}분`} onPick={(v) => setCond({ ...cond, targetWaitSec: v * 60 })} />
            <Pick label="사장님도 일하나요?" value={cond.owner ? 1 : 0} options={[1, 0]} format={(v) => (v ? '네, 같이 일해요' : '아니요')} onPick={(v) => setCond({ ...cond, owner: v === 1 })} />
            <Pick label="직원 시급" value={wageNumber} options={withCurrent([wageFloor(), ...WAGE_STEPS], wageNumber)} format={won} onPick={(v) => setCond({ ...cond, wage: String(v), team: { ...cond.team, people: cond.team.people.map((p) => ({ ...p, wage: String(v) })) } })} />
            <Pick label="에스프레소 머신" value={cond.espresso} options={MACHINE_COUNTS} format={(v) => `${v}대`} onPick={(v) => setCond({ ...cond, espresso: v })} />
            <Pick
              label="가게 데이터"
              value={facts ? -1 : SAMPLES.findIndex((s) => s.label === source?.label)}
              options={SAMPLES.map((_, i) => i)}
              format={(i) => SAMPLES[i].label}
              onPick={(i) => void readSample(SAMPLES[i].file, SAMPLES[i].label)}
            />
            <p className="er-file">
              <button type="button" className="easy-text-button" onClick={() => fileRef.current?.click()}>내 판매 내역 파일 올리기 (엑셀·CSV)</button>
              <small>파일은 이 브라우저 안에서만 읽고, 시간대별 주문 수 같은 정리한 숫자만 저장해요.</small>
            </p>
          </div>
        )}
        {error && <p className="easy-error">{error}</p>}
        <div className={`easy-cta${editing ? ' easy-cta-static' : ''}`}>
          <button type="button" className="easy-primary" disabled={stops.length > 0 || chatBusy} onClick={() => void run()}>
            추천 근무표 만들기
          </button>
          {editing ? (
            <button type="button" className="easy-secondary" onClick={() => setEditing(false)}>다 고쳤어요</button>
          ) : (
            <button type="button" className="easy-secondary" onClick={() => setEditing(true)}>고치기</button>
          )}
        </div>
      </Card>
      {chatBox}
    </div>
  )
}
