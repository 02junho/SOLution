import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { classifyMenuTypes, loadRosterResult, rosterChat, rosterExplain, startRosterResult, warmRoster } from '../../../api/operationApi'
import { workflowApi } from '../../../api/workflowApi'
import type { JsonObject } from '../../../types/workflow'
import { Card, Pick } from '../../easy/views'
import { blocking, formFromPlan } from '../lab/labModel'
import { rosterDays, rosterWorkers } from '../lab/rosterRequest'
import { optionsFromStored, rosterDigest } from '../lab/rosterTypes'
import type { OptionKey, RosterOptions, RosterSummary, StoredRosterResult } from '../lab/rosterTypes'
import { waitRoster } from '../lab/rosterJob'
import { exampleTeam } from '../lab/team'
import { DEFAULT_CLOSE, DEFAULT_OPEN, DEFAULT_TARGET_WAIT_SEC, draftBody, draftOperationInput, FORM_KEY, formInput, MACHINE_COUNTS, TARGET_WAIT_MINUTES, wageFloor } from '../workspace/operationInput'
import { analyzeTable, MENU_TYPES, planFrom, readTable, WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { StoreImport, Weekday } from '../workspace/storeFile'
import EasyRosterResult from './EasyRosterResult'
import { applyReply, chatFields, chatState, chatWorkers, toAliases, toNames } from './easyRosterChat'
import type { RosterConditions } from './easyRosterChat'
import { clock, OPTION_NAME, won } from './easyRosterModel'
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
  { file: 'shinhan_pattern_pos.xlsx', label: '예시 가게 (상권 평균 모양)' },
  { file: 'busy_cafe_pos.xlsx', label: '바쁜 예시 가게 (아침·점심 모두 붐빔)' },
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
}: {
  phase: RosterPhase
  onPhase: (next: 'confirm' | 'running' | 'result' | 'error') => void
  /** 업무를 만들면 알린다(쉬운 화면이 주소를 이 업무로 바꿔 새로 고쳐도 다시 열리게). */
  onSession: (sessionId: number) => void
  opened?: RosterOpened | null
}) {
  const [source, setSource] = useState<{ label: string; imp: StoreImport } | null>(null)
  // 다시 불러온 업무: 저장된 계산 요청(요일별 조건·직원)으로 조건을 채우고, 원본 파일 없이 그 숫자로 다시 계산한다.
  const [restored, setRestored] = useState<{ request: StoredRequest; facts: RestoredFacts } | null>(null)
  const [aiTypes, setAiTypes] = useState<Record<string, string | null>>({})
  const [aiCount, setAiCount] = useState(0)
  const [cond, setCond] = useState<RosterConditions | null>(null)
  const [editing, setEditing] = useState(false)
  const [changedRows, setChangedRows] = useState<string[]>([])
  const [chatText, setChatText] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [chatReply, setChatReply] = useState<{ text: string; ok: boolean } | null>(null)
  const [session, setSession] = useState<number | null>(opened?.sessionId ?? null)
  const [options, setOptions] = useState<RosterOptions | null>(null)
  const [stored, setStored] = useState<{ resultId: number; versionId: number; summary: RosterSummary } | null>(null)
  const [chosen, setChosen] = useState<OptionKey>('RECOMMENDED')
  const [saved, setSaved] = useState('')
  const [explain, setExplain] = useState<{ text: string; ai: boolean } | null>(null)
  const [error, setError] = useState('')
  const [legacy, setLegacy] = useState(false)
  const [seconds, setSeconds] = useState(0)
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
  const dataDays: Weekday[] = facts ? facts.days : plan ? WEEKDAYS.filter((w) => plan.weekdayDays[w]) : []
  const stops = facts ? [] : plan ? blocking(plan) : []
  const peakNow = facts ? facts.peak : plan?.peak ?? null
  const dailyNow = facts ? facts.dailyOrders : plan?.dailyOrders ?? null
  const readOnly = Boolean(opened?.readOnly)

  // ---------------------------------------------------------------- 데이터 읽기
  /** 판매 내역 읽기. 읽었으면 true. */
  async function readFile(file: File, label: string): Promise<boolean> {
    setError('')
    try {
      const next = analyzeTable(await readTable(file), file.name)
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
      // 이름만으로 모른 메뉴만 AI에 종류를 묻는다(이름과 종류 목록만 보냄). 못 물으면 가장 많이 팔린 종류로 둔다.
      const unknown = first.menus.filter((m) => m.how === 'GUESS').map((m) => m.name).slice(0, 40)
      if (unknown.length) {
        const response = await classifyMenuTypes({ names: unknown, types: MENU_TYPES })
        if (response.status === 'ok' && response.data?.source === 'LLM') {
          const picked = Object.fromEntries(
            Object.entries(response.data.types)
              .filter(([, v]) => v !== null)
              .map(([k, v]) => [k, v === 'FOOD' ? null : v]),
          ) as Record<string, string | null>
          setAiTypes(picked)
          setAiCount(Object.keys(picked).length)
        }
      }
      return true
    } catch (cause) {
      setError(errorText(cause, '가게 데이터를 읽지 못했어요.'))
      return false
    }
  }
  async function readSample(file: string, label: string): Promise<boolean> {
    const response = await fetch(`/samples/${file}`)
    if (!response.ok) {
      setError('예시 가게 데이터를 불러오지 못했어요.')
      return false
    }
    return readFile(new File([await response.blob()], file), label)
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
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      if (opened?.resultId) {
        const back = await showSaved(opened.resultId)
        if (!back && !opened.readOnly) await readSample(SAMPLES[0].file, MYSHOP_LABEL)
        return
      }
      await readSample(SAMPLES[0].file, MYSHOP_LABEL)
      onPhase('confirm')
    })()
    // 처음 한 번만. 다른 업무를 열면 쉬운 화면이 이 조각을 새로 만든다(key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** 저장된 결과 열기. 저장된 조건으로 다시 불러왔으면 true. */
  async function showSaved(resultId: number): Promise<boolean> {
    try {
      const detail = await loadRosterResult(resultId)
      if (detail.status !== 'ok' || !detail.data) throw new Error(detail.message ?? '근무표를 불러오지 못했어요.')
      const data = detail.data as StoredRosterResult
      if (data.summary?.result_kind !== 'ROSTER_OPTIONS') {
        setLegacy(true)
        onPhase('result')
        return false
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
      onPhase('result')
      return Boolean(back && !opened?.readOnly)
    } catch (cause) {
      setError(errorText(cause, '근무표를 불러오지 못했어요.'))
      onPhase('error')
      return false
    }
  }

  function show(data: StoredRosterResult) {
    const next = optionsFromStored(data)
    setOptions(next)
    setStored({ resultId: data.result_id, versionId: data.input_version_id, summary: data.summary })
    setChosen(data.summary.recommended_choice_key ?? 'RECOMMENDED')
    void explainResult(next, data.summary)
  }

  async function explainResult(data: RosterOptions, summary: RosterSummary) {
    const fallback = summary.message
    setExplain({ text: fallback, ai: false })
    try {
      const response = await rosterExplain({ result: rosterDigest(data), fallback })
      if (response.status === 'ok' && response.data) setExplain({ text: response.data.text, ai: response.data.source === 'LLM' })
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
    // 쉬운 화면은 주휴 비교를 보여 주지 않으므로 계산하지 않는다(요일마다 근무표 하나를 덜 짜서 빨라진다).
    return { days, workers: rosterWorkers(c.team.people), compare_holiday_pay: false }
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
  }, [warmStage, cond, restored, imp, aiTypes])
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
    const people = { isOwnerWorking: c.owner, hourlyWage: Number(c.wage) }
    const form = !restored && imp && plan ? formFromPlan(imp, plan, people, equipment(c)) : null
    const stop = { stopped: false }
    stopRef.current = stop
    setError('')
    setSaved('')
    setSeconds(0)
    setChatReply(null)
    onPhase('running')
    try {
      if (form) await draftOperationInput(form)
      let sessionId = session
      if (!sessionId) {
        const created = await workflowApi.create(Number(import.meta.env.VITE_STORE_ID ?? 1), 'operation', 'form', '[쉬운 화면] 점심 인원 근무표')
        sessionId = created.session_id
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
      const body = rosterBody(c)
      if (!(body.days as JsonObject[]).length) throw new Error('근무표를 만들 요일 데이터가 없어요.')
      const key = crypto.randomUUID()
      const begun = await startRosterResult(sessionId, { input_version_id: versionId, ...body }, key)
      if (begun.status !== 'ok' || !begun.data) throw new Error(begun.message ?? '계산을 시작하지 못했어요.')
      const job = begun.data.state === 'DONE' ? begun.data : await waitRoster({ sessionId, versionId, key }, setSeconds, stop)
      if (!job || stop.stopped) return
      if (!job.result_id) throw new Error('추천 근무표를 만들지 못했어요.')
      const detail = await loadRosterResult(job.result_id)
      if (detail.status !== 'ok' || !detail.data) throw new Error(detail.message ?? '근무표를 불러오지 못했어요.')
      if (stop.stopped) return
      show(detail.data)
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
    try {
      const response = await rosterChat({
        // 직원 이름은 별칭으로 바꿔 보내고(AI에 이름이 가지 않게), 답장은 다시 이름으로 바꿔 보여 준다.
        message: toAliases(message, cond.team.people),
        fields: chatFields(open, close, dataDays),
        state: chatState(cond, { open, close, busy: peakNow ? `${peakNow.start}~${peakNow.end}` : null, dailyOrders: dailyNow }),
        workers: chatWorkers(cond.team.people),
        ...(options ? { result: rosterDigest(options) } : {}),
      })
      if (response.status !== 'ok' || !response.data) throw new Error(response.message ?? '말을 처리하지 못했어요.')
      const reply = response.data
      const applied = applyReply(cond, reply, { open, close })
      setChatText('')
      setChatReply({ text: toNames(reply.reply, cond.team.people), ok: applied.changed })
      if (applied.changed) {
        setCond(applied.next)
        setChangedRows(applied.rows)
      }
      // 결과를 보고 있었으면 바뀐 조건으로 바로 다시 계산한다(다음 렌더에서 최신 조건으로).
      if ((applied.changed || reply.intent === 'RUN') && phase === 'result') rerunNext.current = true
      else if (reply.intent === 'RUN' && phase === 'confirm') rerunNext.current = true
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
          rows={2}
          maxLength={300}
          value={chatText}
          placeholder={phase === 'result' ? '예: 토요일은 내가 못 나와' : '예: 손님 3분 넘게 안 기다리게 해 줘'}
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
      {chatReply && (
        <p className={`er-reply${chatReply.ok ? ' ok' : ''}`} role="status">
          {chatReply.ok && <i aria-hidden>✓ </i>}
          {chatReply.text}
        </p>
      )}
      <p className="easy-muted er-small">AI가 고칠 칸을 고르면, 값이 허용 범위 안인지 다시 확인한 뒤에만 반영해요.</p>
    </section>
  )

  // ---------------------------------------------------------------- 그리기
  if (phase === 'loading' || phase === 'start' || phase === 'ask') return null

  if (phase === 'running')
    return (
      <div className="easy-running" role="status">
        <span className="easy-spinner" aria-hidden />
        <span>
          요일마다 사람을 한 명씩 늘려 보며 대기 시간을 재는 중이에요{seconds ? ` (${seconds}초)` : ''}
          <small className="er-running-note">창을 닫아도 계산은 계속돼요. "하던 일 이어하기"에서 다시 열 수 있어요.</small>
        </span>
      </div>
    )

  if (phase === 'error')
    return (
      <Card title="잠깐 연결이 안 됐어요">
        <p>{error || '계산을 마치지 못했어요.'}</p>
        <p className="easy-muted">조건은 그대로예요. 잠시 뒤 "다시 시도"를 눌러 주세요.</p>
        <div className="easy-actions">
          {!readOnly && cond && <button type="button" className="easy-primary" onClick={() => void run()}>다시 시도</button>}
          {!readOnly && <button type="button" className="easy-secondary" onClick={() => onPhase('confirm')}>조건 다시 보기</button>}
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
      />
    )
  }

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
      <Card title="어떤 데이터로 근무표를 만들까요?" tour="confirm">
        {fileInput}
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
  const sourceTag = facts ? '지난번 조건' : source?.label === MYSHOP_LABEL ? '마이샵' : source?.label.startsWith('내 판매 내역') ? '내 파일' : '예시'
  return (
    <>
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
            <b>{peakNow ? `${clock(peakNow.start)} ~ ${clock(peakNow.end)}` : '찾지 못했어요'}{' · 요일마다 다시 찾아요'}</b>
          </li>
          <li className={row('owner')}>
            <span>사장님 근무</span>
            <b>{ownerText}</b>
          </li>
          <li className={row('team')}>
            <span>알바 후보</span>
            <b>{cond.team.people.length}명 {facts ? '(지난번 명단)' : '(예시 명단)'}</b>
          </li>
          <li className={row('target')}>
            <span>목표 대기</span>
            <b>{cond.targetWaitSec / 60}분 안 (손님 10명 중 9명)</b>
          </li>
          <li className={row('machines')}>
            <span>기계</span>
            <b>에스프레소 머신 {cond.espresso}대 · 블렌더 {cond.blenders}대</b>
          </li>
          <li className={row('wage')}>
            <span>알바 시급 · 규칙</span>
            <b>{won(wageNumber)} · 주 15시간 미만 · 휴게 포함</b>
          </li>
        </ul>
        {facts && <p className="easy-muted er-small">지난번에 저장한 조건과 직원 명단을 그대로 불러왔어요. 고친 뒤 다시 계산하면 같은 업무에 새로 저장돼요.</p>}
        {!facts && aiCount > 0 && <p className="easy-muted er-small">메뉴 이름만으로 모른 {aiCount}개는 AI가 음료 종류를 골랐어요.</p>}
        {stops.length > 0 && <p className="easy-error">{stops[0]}</p>}
        {editing && (
          <div className="easy-edit">
            <Pick label="목표 대기" value={cond.targetWaitSec / 60} options={withCurrent(WAIT_CHOICES, cond.targetWaitSec / 60)} format={(v) => `${v}분`} onPick={(v) => setCond({ ...cond, targetWaitSec: v * 60 })} />
            <Pick label="사장님도 일하나요?" value={cond.owner ? 1 : 0} options={[1, 0]} format={(v) => (v ? '네, 같이 일해요' : '아니요')} onPick={(v) => setCond({ ...cond, owner: v === 1 })} />
            <Pick label="알바 시급" value={wageNumber} options={withCurrent([wageFloor(), ...WAGE_STEPS], wageNumber)} format={won} onPick={(v) => setCond({ ...cond, wage: String(v), team: { ...cond.team, people: cond.team.people.map((p) => ({ ...p, wage: String(v) })) } })} />
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
          <button type="button" className="easy-primary" disabled={stops.length > 0} onClick={() => void run()}>
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
    </>
  )
}
