import { useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { classifyMenuTypes, loadRosterResult, rosterChat, rosterExplain, startRosterResult } from '../../../api/operationApi'
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
import { applyReply, chatFields, chatState, chatWorkers } from './easyRosterChat'
import type { RosterConditions } from './easyRosterChat'
import { clock, OPTION_NAME, won } from './easyRosterModel'
import { equipmentOf, patchForm, restoreConditions, restoredDayBodies, restoredFacts } from './easyRosterRestore'
import type { RestoredFacts, StoredRequest } from './easyRosterRestore'
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
const SAMPLES = [
  { file: 'shinhan_pattern_pos.xlsx', label: '예시 가게 (상권 평균 모양)' },
  { file: 'busy_cafe_pos.xlsx', label: '바쁜 예시 가게 (아침·점심 모두 붐빔)' },
]
// 쉬운 화면은 버튼을 적게: 목표 대기 선택지(TARGET_WAIT_MINUTES) 중 3·5·7분만 보인다. 지금 값이 다르면 그 값도 같이 보인다.
const WAIT_CHOICES = TARGET_WAIT_MINUTES.filter((m) => m === 3 || m === 5 || m === 7)
// 시급 빠른 선택: 올해 최저시급 + 쉬운 화면 다른 업무와 같은 두 값(직접 바꾸려면 말로 고치기)
const WAGE_STEPS = [11000, 12000]
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
  async function readFile(file: File, label: string) {
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
    } catch (cause) {
      setError(errorText(cause, '가게 데이터를 읽지 못했어요.'))
    }
  }
  async function readSample(file: string, label: string) {
    const response = await fetch(`/samples/${file}`)
    if (!response.ok) {
      setError('예시 가게 데이터를 불러오지 못했어요.')
      return
    }
    await readFile(new File([await response.blob()], file), label)
  }

  // 처음: 저장된 결과가 있으면 그 결과를, 없으면 예시 가게 데이터로 조건 확인부터.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      await readSample(SAMPLES[0].file, SAMPLES[0].label)
      if (opened?.resultId) await showSaved(opened.resultId)
      else onPhase('confirm')
    })()
    // 처음 한 번만. 다른 업무를 열면 쉬운 화면이 이 조각을 새로 만든다(key).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function showSaved(resultId: number) {
    try {
      const detail = await loadRosterResult(resultId)
      if (detail.status !== 'ok' || !detail.data) throw new Error(detail.message ?? '근무표를 불러오지 못했어요.')
      const data = detail.data as StoredRosterResult
      if (data.summary?.result_kind !== 'ROSTER_OPTIONS') {
        setLegacy(true)
        onPhase('result')
        return
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
    } catch (cause) {
      setError(errorText(cause, '근무표를 불러오지 못했어요.'))
      onPhase('error')
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
      if (!days.length) throw new Error('근무표를 만들 요일 데이터가 없어요.')
      const key = crypto.randomUUID()
      const begun = await startRosterResult(sessionId, { input_version_id: versionId, days, workers: rosterWorkers(c.team.people) }, key)
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
        message,
        fields: chatFields(open, close, dataDays),
        state: chatState(cond, { open, close, busy: peakNow ? `${peakNow.start}~${peakNow.end}` : null, dailyOrders: dailyNow }),
        workers: chatWorkers(cond.team.people),
        ...(options ? { result: rosterDigest(options) } : {}),
      })
      if (response.status !== 'ok' || !response.data) throw new Error(response.message ?? '말을 처리하지 못했어요.')
      const reply = response.data
      const applied = applyReply(cond, reply, { open, close })
      setChatText('')
      setChatReply({ text: reply.reply, ok: applied.changed })
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
  return (
    <>
      <Card title="이 조건이 맞나요?" tour="confirm">
        <ul className="easy-facts er-facts">
          <li>
            <span>
              가게 데이터 <em className="er-tag">{facts ? '지난번 조건' : '예시'}</em>
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
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.csv"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0]
                  if (file) void readFile(file, `올린 파일 (${file.name})`)
                  e.target.value = ''
                }}
              />
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
