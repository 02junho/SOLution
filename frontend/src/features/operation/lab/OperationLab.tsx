import { useEffect, useMemo, useRef, useState } from 'react'
import { classifyMenuTypes, rosterExplain } from '../../../api/operationApi'
import { workflowApi } from '../../../api/workflowApi'
import { DEFAULT_TARGET_WAIT_SEC, draftBody, DEFAULT_CLOSE, DEFAULT_OPEN, draftOperationInput, equipmentFrom, formInput, MACHINE_COUNTS, MENUS, TARGET_WAIT_MINUTES, wageFloor } from '../workspace/operationInput'
import type { Equipment } from '../workspace/operationInput'
import { analyzeTable, CARD_SHARE_MIN, MENU_TYPES, planFrom, readTable, typeLabel, typeSeconds, WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { DayBasis, MenuHow, StoreImport } from '../workspace/storeFile'
import { blocking, checkMessage, formFromPlan, hourEdges } from './labModel'
import RosterCard from './RosterCard'
import RosterChat from './RosterChat'
import type { ChatField, ChatLine } from './RosterChat'
import { rosterDigest } from './rosterTypes'
import type { RosterChatReply, RosterOptions, RosterSummary } from './rosterTypes'
import { readPending } from './rosterJob'
import SavedRoster, { PendingRoster } from './SavedRoster'
import { exampleTeam, MAX_TEAM } from './team'
import type { Person, Team } from './team'
import WeeklyCard from './WeeklyCard'
import '../operation.css'
import './lab.css'

/*
 * 운영 실험실 (#/lab) · 운영 2번(가게 데이터 버전) 확인용 화면.
 * 가게 파일 올리기 → 정리 결과 확인(빈 값은 기본값으로 채우고 표시) → 세 운영안 비교 → 결과.
 * 저장·계산은 지금 업무 API를 그대로 쓴다(업무 만들기 → 폼 저장 → 입력 확인 → 계산). 파일은 브라우저 안에서만 읽는다.
 */

// 시연용 가상 매장 데이터. 신한 상권 분포 예시는 시간대·요일 모양을 서울시 상권분석서비스(을지로입구 커피,
// 신한카드 결제 기반) 분기 중앙값에 맞췄다(파일 첫 줄에 출처를 적음). 하루 주문 수와 메뉴 구성은 가정이다.
const SAMPLES = [
  { file: 'myshop_approvals_sample.csv', label: '마이샵 승인 내역 예시 (CSV · 결제 시각만)', group: '임의 예시 매장 · 2주' },
  { file: 'pos_sales_sample.xlsx', label: 'POS 판매 내역 예시 (엑셀 · 메뉴 포함)', group: '임의 예시 매장 · 2주' },
  { file: 'shinhan_pattern_approvals.csv', label: '승인 내역 (CSV · 결제 시각만)', group: '신한 상권 분포 예시 매장 · 4주' },
  { file: 'shinhan_pattern_pos.xlsx', label: '판매 내역 (엑셀 · 메뉴 이름 제각각)', group: '신한 상권 분포 예시 매장 · 4주' },
  { file: 'busy_cafe_pos.xlsx', label: '판매 내역 (엑셀 · 아침·점심 모두 붐빔)', group: '바쁜 카페 예시 매장 · 4주' },
]
const menuName = (id: string) => MENUS.find((m) => m.menu_id === id)?.menu_name ?? id
const HOW_TEXT: Record<MenuHow, string> = {
  EXACT: '같은 메뉴',
  KEYWORD: '이름으로 추정',
  AI: 'AI 추정',
  FOOD: '음료 아님',
  GUESS: '확인 필요',
}
const MIN_MAKE_SEC = 10
const MAX_MAKE_SEC = 600
const basisLabel = (b: DayBasis) => (b === 'AVERAGE' ? '평균 하루' : `${WEEKDAY_LABEL[b]}요일 평균`)

/** #/lab?result=번호 → 저장한 추천 근무표, #/lab?session=…&version=…&key=… → 계산 중이던 근무표 이어 보기, 아니면 실험실. */
export default function OperationLab() {
  const hash = window.location.hash
  const id = Number(new URLSearchParams(hash.split('?')[1] ?? '').get('result'))
  if (Number.isInteger(id) && id > 0) return <SavedRoster resultId={id} />
  const pending = readPending(hash)
  return pending ? <PendingRoster pending={pending} /> : <LabMain />
}

function LabMain() {
  const [imp, setImp] = useState<StoreImport | null>(null)
  const [readError, setReadError] = useState('')
  const [basis, setBasis] = useState<DayBasis>('AVERAGE')
  const [peak, setPeak] = useState<{ start: string; end: string } | null>(null)
  const [mapping, setMapping] = useState<Record<string, string | null>>({})
  /** 낱말로 모른 메뉴를 AI가 고른 유형(null = 음료 아님) */
  const [aiTypes, setAiTypes] = useState<Record<string, string | null>>({})
  const [aiNote, setAiNote] = useState('')
  /** 유형별 제조 시간(초) 고친 값 */
  const [makeSec, setMakeSec] = useState<Record<string, string>>({})
  /** 파일 결제가 전체에서 차지하는 비율(%). 100이면 보정 안 함. */
  const [cardShare, setCardShare] = useState('100')
  const [owner, setOwner] = useState(true)
  const [wage, setWage] = useState(String(wageFloor()))
  const [espresso, setEspresso] = useState(1)
  const [blenders, setBlenders] = useState(1)
  const [targetWait, setTargetWait] = useState(DEFAULT_TARGET_WAIT_SEC)
  const [status, setStatus] = useState('')
  const [runError, setRunError] = useState('')
  /** 저장한 업무와 확인한 입력 버전. 추천 근무표를 이 업무의 결과로 저장한다. */
  const [saved, setSaved] = useState<{ sessionId: number; versionId: number } | null>(null)
  /** 한 번에 계산: 비교가 끝나면 늘려서 하루·일주일 근무표도 바로 만든다. */
  const [autoRun, setAutoRun] = useState(0)
  /** 하루 근무표가 끝나면 늘려서 추천 근무표를 이어서 만든다(두 계산을 동시에 돌리면 서버가 느려진다). */
  const [weekRun, setWeekRun] = useState(0)
  /** 직원 명단·사장님 근무(일주일 근무표). 말로 고치기도 여기를 바꾼다. */
  const [team, setTeam] = useState<Team | null>(null)
  const [chat, setChat] = useState<ChatLine[]>([])
  /** 마지막 추천 근무표(말로 묻기·결과 설명용 요약). */
  const [digest, setDigest] = useState<Record<string, unknown> | null>(null)
  /** 말로 고친 뒤 다시 계산할지(다음 렌더에서 최신 값으로 run). */
  const [rerun, setRerun] = useState(0)

  const shareNumber = Number(cardShare)
  const shareProblem =
    !/^\d+$/.test(cardShare) || shareNumber < CARD_SHARE_MIN * 100 || shareNumber > 100
      ? `${CARD_SHARE_MIN * 100}~100% 사이로 적어 주세요.`
      : ''
  const plan = useMemo(
    () => (imp ? planFrom(imp, basis, peak, mapping, shareProblem ? 1 : shareNumber / 100, aiTypes) : null),
    [imp, basis, peak, mapping, shareNumber, shareProblem, aiTypes],
  )
  const stops = plan ? blocking(plan) : []
  const wageNumber = Number(wage)
  const minimum = wageFloor()
  const wageProblem = !/^\d+$/.test(wage) || wageNumber < minimum ? `시급은 ${minimum.toLocaleString('ko-KR')}원 이상으로 적어 주세요.` : ''
  const busy = status !== ''
  const makeProblem = Object.entries(makeSec).some(([, v]) => !/^\d+$/.test(v) || Number(v) < MIN_MAKE_SEC || Number(v) > MAX_MAKE_SEC)
    ? `제조 시간은 ${MIN_MAKE_SEC}~${MAX_MAKE_SEC}초로 적어 주세요.`
    : ''
  const manufacture = makeProblem ? {} : Object.fromEntries(Object.entries(makeSec).map(([id, v]) => [id, Number(v)]))
  // 기본값과 같으면 보내지 않는다(저장 본문이 지금과 같게).
  const equipment: Equipment = equipmentFrom(espresso, blenders, targetWait)

  async function load(file: File) {
    setReadError('')
    setSaved(null)
    setRunError('')
    try {
      const next = analyzeTable(await readTable(file), file.name)
      setImp(next)
      setBasis('AVERAGE')
      setPeak(null)
      setMapping({})
      setCardShare('100')
      setMakeSec({})
      setAiTypes({})
      setAiNote('')
      setChat([])
      setDigest(null)
      const first = planFrom(next)
      setTeam(
        exampleTeam(wage, first.open ?? DEFAULT_OPEN, first.close ?? DEFAULT_CLOSE, WEEKDAYS.filter((w) => first.weekdayDays[w])),
      )
      // 낱말로 모른 메뉴 이름만 AI에 묻는다(이름과 유형 목록만 보냄). 실패하면 가장 많이 팔린 유형으로 채운 그대로 둔다.
      const unknown = planFrom(next).menus.filter((m) => m.how === 'GUESS').map((m) => m.name).slice(0, 40)
      if (unknown.length) {
        setAiNote(`이름으로 모른 메뉴 ${unknown.length}개를 AI에 물어보고 있어요…`)
        const response = await classifyMenuTypes({ names: unknown, types: MENU_TYPES })
        const types = response.status === 'ok' && response.data ? response.data.types : {}
        const picked = Object.fromEntries(
          Object.entries(types)
            .filter(([, v]) => v !== null)
            .map(([k, v]) => [k, v === 'FOOD' ? null : v]),
        ) as Record<string, string | null>
        setAiTypes(picked)
        setAiNote(
          response.status === 'ok' && response.data?.source === 'LLM'
            ? `AI가 메뉴 ${Object.keys(picked).length}개의 유형을 골랐어요. 표에서 'AI 추정'으로 보여요.`
            : 'AI에 물어보지 못했어요. 모른 메뉴는 가장 많이 팔린 유형으로 넣었어요.',
        )
      }
    } catch (cause) {
      setImp(null)
      setReadError(cause instanceof Error ? cause.message : '파일을 읽지 못했어요.')
    }
  }
  async function loadSample(name: string) {
    const response = await fetch(`/samples/${name}`)
    if (!response.ok) {
      setReadError('예시 파일을 불러오지 못했어요.')
      return
    }
    await load(new File([await response.blob()], name))
  }

  /**
   * 한 번에 계산: 업무를 만들고 정리한 조건을 저장·확인한 뒤(DB에 남음) 하루 근무표 → 추천 근무표 3안 순서로 만든다.
   * 운영 1번의 세 운영안 비교는 2번 흐름에서 쓰지 않는다(추천 근무표가 "사람을 더 쓰면"을 더 자세히 보여 준다).
   */
  async function run() {
    if (!imp || !plan || stops.length || wageProblem) return
    const form = formFromPlan(imp, plan, { isOwnerWorking: owner, hourlyWage: wageNumber }, equipment, manufacture)
    setRunError('')
    setSaved(null)
    try {
      setStatus('조건을 확인하고 있어요')
      await draftOperationInput(form)
      setStatus('업무를 만들고 조건을 저장하고 있어요')
      const store = Number(import.meta.env.VITE_STORE_ID ?? 1)
      const { session_id } = await workflowApi.create(store, 'operation', 'form', `가게 데이터 근무표 · ${imp.fileName}`)
      let context = await workflowApi.context(session_id)
      await workflowApi.event(
        session_id,
        { event_type: 'form', form_input: formInput(form), base_version_id: context.current_version_id },
        crypto.randomUUID(),
      )
      context = await workflowApi.context(session_id)
      if (!context.current_version_id) throw new Error('조건이 저장되지 않았어요.')
      await workflowApi.confirmInput(context.current_version_id, context.current_version)
      setSaved({ sessionId: session_id, versionId: context.current_version_id })
      setAutoRun((n) => n + 1)
    } catch (cause) {
      setRunError(cause instanceof Error ? cause.message : '저장하지 못했어요.')
    } finally {
      setStatus('')
    }
  }

  // ---------------------------------------------------------------- 말로 고치기
  const open = plan?.open ?? DEFAULT_OPEN
  const close = plan?.close ?? DEFAULT_CLOSE
  const dataDays = plan ? WEEKDAYS.filter((w) => plan.weekdayDays[w]) : []
  /** 바꿀 수 있는 칸과 범위. AI에 데이터로 보내고, 서버가 이 범위로 AI 답을 다시 검사한다. */
  const chatFields: ChatField[] = [
    { key: 'target_wait_min', label: '목표 대기(분)', hint: '주문 후 받기까지, 10명 중 9명이 이 안에 받게', type: 'int', min: Math.min(...TARGET_WAIT_MINUTES), max: Math.max(...TARGET_WAIT_MINUTES) },
    { key: 'espresso_machines', label: '에스프레소 머신 대수', type: 'int', min: Math.min(...MACHINE_COUNTS), max: Math.max(...MACHINE_COUNTS) },
    { key: 'blenders', label: '블렌더 대수', type: 'int', min: Math.min(...MACHINE_COUNTS), max: Math.max(...MACHINE_COUNTS) },
    { key: 'owner_working', label: '사장님 근무', hint: '사장님이 매장에서 직접 일하는지', type: 'bool' },
    { key: 'owner_days', label: '사장님 근무 요일', type: 'choices', choices: dataDays, choice_labels: WEEKDAY_LABEL },
    { key: 'owner_start', label: '사장님 출근 시각', type: 'time', min: open, max: close, step_min: 30 },
    { key: 'owner_end', label: '사장님 퇴근 시각', type: 'time', min: open, max: close, step_min: 30 },
    { key: 'hourly_wage', label: '직원 시급(원)', type: 'int', min: wageFloor(), max: 100_000 },
    { key: 'basis_day', label: '계산할 하루', hint: '하루 근무표 기준. AVERAGE는 평균 하루', type: 'choice', choices: ['AVERAGE', ...dataDays], choice_labels: { AVERAGE: '평균 하루', ...Object.fromEntries(dataDays.map((d) => [d, `${WEEKDAY_LABEL[d]}요일`])) } },
    { key: 'card_share_pct', label: '파일에 담긴 결제 비율(%)', hint: '현금·쿠폰처럼 파일에 없는 결제를 보정', type: 'int', min: Math.round(CARD_SHARE_MIN * 100), max: 100 },
    { key: 'workers', label: '직원 명단', hint: 'worker_changes로 더하기·빼기·고치기, 직원은 alias로', type: 'bool', time_min: open, time_max: close },
  ]
  // 직원 이름은 보내지 않고 별칭(P1…)만 보낸다.
  const aliasOf = (i: number) => `P${i + 1}`
  const chatWorkers = (team?.people ?? []).map((p, i) => ({
    alias: aliasOf(i),
    days: p.days,
    start: p.start,
    end: p.end,
    max_hours: Number(p.maxHours),
    minor: p.minor,
  }))
  const chatState = {
    target_wait_min: targetWait / 60,
    espresso_machines: espresso,
    blenders,
    owner_working: owner,
    owner_days: team?.ownerDays ?? [],
    owner_start: team?.ownerStart ?? open,
    owner_end: team?.ownerEnd ?? close,
    hourly_wage: wageNumber,
    basis_day: basis,
    card_share_pct: shareProblem ? 100 : shareNumber,
    open_time: open,
    close_time: close,
    busy_time: plan?.peak ? `${plan.peak.start}~${plan.peak.end}` : null,
    daily_orders: plan?.dailyOrders ?? null,
  }

  /** 서버가 검사한 변경만 칸에 넣는다. 바꾼 것이 있으면 다시 계산한다(이미 한 번 계산했을 때). */
  function applyChat(reply: RosterChatReply) {
    let nextTeam = team
    for (const { key, value } of reply.changes) {
      if (key === 'target_wait_min' && typeof value === 'number') setTargetWait(value * 60)
      else if (key === 'espresso_machines' && typeof value === 'number') setEspresso(value)
      else if (key === 'blenders' && typeof value === 'number') setBlenders(value)
      else if (key === 'owner_working' && typeof value === 'boolean') setOwner(value)
      else if (key === 'hourly_wage' && typeof value === 'number') setWage(String(value))
      else if (key === 'basis_day' && typeof value === 'string') setBasis(value as DayBasis)
      else if (key === 'card_share_pct' && typeof value === 'number') setCardShare(String(value))
      else if (nextTeam && key === 'owner_days' && Array.isArray(value)) nextTeam = { ...nextTeam, ownerDays: value as Team['ownerDays'] }
      else if (nextTeam && key === 'owner_start' && typeof value === 'string') nextTeam = { ...nextTeam, ownerStart: value }
      else if (nextTeam && key === 'owner_end' && typeof value === 'string') nextTeam = { ...nextTeam, ownerEnd: value }
    }
    if (nextTeam) {
      let people = [...nextTeam.people]
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
          people.push({ id, name: `새 직원 ${people.length + 1}`, wage, minor: false, days: [], start: open, end: close, maxHours: '14', ...patch })
        } else if (change.op === 'remove') {
          const id = byAlias.get(change.alias)
          if (people.length > 1) people = people.filter((p) => p.id !== id)
        } else if (change.op === 'update') {
          const id = byAlias.get(change.alias)
          people = people.map((p) => (p.id === id ? { ...p, ...patch } : p))
        }
      }
      nextTeam = { ...nextTeam, people }
      setTeam(nextTeam)
    }
    const changed = reply.changes.length > 0 || reply.worker_changes.length > 0
    if ((changed || reply.intent === 'RUN') && saved) {
      setRerun((n) => n + 1)
      setChat((lines) => [...lines, { who: 'ai', text: '바뀐 조건으로 다시 계산하고 있어요. 아래 근무표가 새로 채워져요.' }])
    } else if (changed || reply.intent === 'RUN')
      setChat((lines) => [...lines, { who: 'ai', text: '아직 계산 전이라 아래 "확인했어요" 버튼을 누르면 바뀐 조건으로 계산해요.' }])
  }
  // 말로 고친 값이 반영된 다음 렌더에서 다시 계산한다(그 렌더의 run이 최신 값을 본다).
  const runRef = useRef<() => Promise<void>>(async () => {})
  const lastRerun = useRef(0)
  useEffect(() => {
    runRef.current = run
  })
  useEffect(() => {
    if (rerun === lastRerun.current) return
    lastRerun.current = rerun
    void runRef.current()
  }, [rerun])

  /** 추천 근무표가 나오면 요약을 남기고, AI 설명(결과에 있는 숫자만)을 대화에 붙인다. 실패하면 코드 요약 문장. */
  async function onOptions(data: RosterOptions, summary: RosterSummary | null) {
    const next = rosterDigest(data)
    setDigest(next)
    const fallback = summary?.message ?? '추천 근무표 세 가지를 만들었어요. 아래 카드에서 비교해 보세요.'
    try {
      const response = await rosterExplain({ result: next, fallback })
      const text = response.status === 'ok' && response.data ? response.data.text : fallback
      setChat((lines) => [...lines, { who: 'ai', text, note: response.data?.source === 'LLM' ? 'AI 설명' : undefined }])
    } catch {
      setChat((lines) => [...lines, { who: 'ai', text: fallback }])
    }
  }

  const slots = plan?.ordersBySlot ? Object.entries(plan.ordersBySlot) : []
  const maxSlot = Math.max(1, ...slots.map(([, n]) => n))
  const edges = hourEdges(plan?.open ?? null, plan?.close ?? null)
  const inPeak = (label: string) => plan?.peak && label.slice(0, 5) >= plan.peak.start && label.slice(6) <= plan.peak.end

  return (
    <div className="lab-page">
      <header className="lab-head">
        <a href="#/work">← 업무 공간</a>
        <h1>운영 실험실 · 가게 데이터 버전</h1>
        <p>
          가게의 결제·판매 파일을 올리면 시간대별 손님, 영업시간, 바쁜 시간, 메뉴 구성을 뽑아 세 운영안을 비교해요. 파일은 이
          브라우저 안에서만 읽고, 정리한 숫자와 근거(파일 이름·기간·줄 수)만 저장해요.
        </p>
      </header>

      <section className="lab-card">
        <h2>1. 파일 올리기</h2>
        <label className="lab-drop">
          <input
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void load(file)
              e.target.value = ''
            }}
          />
          <b>CSV 또는 엑셀(xlsx) 파일 고르기</b>
          <small>결제 시각(승인일시·거래일시)이나 메뉴(품목·상품명) 열이 있으면 돼요. 예전 엑셀(.xls)은 xlsx·CSV로 저장해 주세요.</small>
        </label>
        {[...new Set(SAMPLES.map((s) => s.group))].map((group) => (
          <div key={group} className="lab-samples">
            <b>{group}</b>
            {SAMPLES.filter((s) => s.group === group).map((s) => (
              <span key={s.file}>
                <button type="button" className="button secondary" disabled={busy} onClick={() => void loadSample(s.file)}>
                  {s.label}로 해보기
                </button>
                <a href={`/samples/${s.file}`} download>
                  내려받기
                </a>
              </span>
            ))}
          </div>
        ))}
        <p className="lab-muted">
          예시 파일은 모두 시연용 가상 매장이에요. 신한 상권 분포 예시는 시간대·요일 모양을 서울시 상권분석서비스(을지로입구
          커피 상권, 신한카드 결제 기반)에 맞췄고, 하루 주문 수와 메뉴 구성은 가정이에요. 바쁜 카페 예시는 아침과 점심이 모두
          붐비는 하루 250잔 안팎의 매장을 가정했어요.
        </p>
        {readError && (
          <p className="lab-error" role="alert">
            {readError}
          </p>
        )}
      </section>

      {imp && plan && (
        <section className="lab-card">
          <h2>2. 정리한 결과 확인</h2>
          {(() => {
            const msg = checkMessage(imp, plan, {
              basis,
              peakEdited: peak !== null,
              mapping,
              cardSharePercent: shareProblem ? 100 : shareNumber,
              makeSec: manufacture,
              isOwnerWorking: owner,
              hourlyWage: wageNumber,
              minimumWage: minimum,
              espressoMachines: espresso,
              blenders,
              targetWaitSec: targetWait,
              defaultTargetWaitSec: DEFAULT_TARGET_WAIT_SEC,
            })
            return (
              <div className="lab-message" role="status">
                <p>{msg.summary}</p>
                {msg.check.length > 0 && (
                  <>
                    <p>
                      <b>비어 있던 정보는 채워 두었어요. {msg.check.map((c) => c.area).join(', ')}만 확인해 주세요.</b>
                    </p>
                    {msg.check.map((c) => (
                      <details key={c.area}>
                        <summary>
                          {c.area} ({c.items.length})
                        </summary>
                        <ul>
                          {c.items.map((t) => (
                            <li key={t}>{t}</li>
                          ))}
                        </ul>
                      </details>
                    ))}
                  </>
                )}
                {msg.changed.length > 0 && (
                  <>
                    <p>
                      <b>바꾼 것</b>
                    </p>
                    <ul>
                      {msg.changed.map((t) => (
                        <li key={t}>{t}</li>
                      ))}
                    </ul>
                  </>
                )}
                <small className="lab-muted">고칠 곳은 아래 칸에서 바로 고치면 돼요. 고친 내용은 여기 "바꾼 것"에 모여요.</small>
              </div>
            )
          })()}
          {team && (
            <RosterChat
              fields={chatFields}
              state={chatState}
              workers={chatWorkers}
              result={digest}
              disabled={busy}
              lines={chat}
              onLines={setChat}
              onReply={applyChat}
            />
          )}
          <dl className="lab-facts">
            <div>
              <dt>파일</dt>
              <dd>{imp.fileName}</dd>
            </div>
            <div>
              <dt>읽은 열</dt>
              <dd>{Object.values(imp.columns).join(' · ')}</dd>
            </div>
            <div>
              <dt>기간</dt>
              <dd>{plan.period ? `${plan.period.from} ~ ${plan.period.to} (${plan.days}일)` : '날짜 없음'}</dd>
            </div>
            <div>
              <dt>읽은 줄</dt>
              <dd>
                {imp.rowsRead.toLocaleString('ko-KR')}줄 · 취소 {imp.excluded.cancelled} · 못 읽음 {imp.excluded.unreadable} · 중복{' '}
                {imp.excluded.duplicate}
                {plan.outsideHours > 0 && ` · 영업시간 밖 하루 평균 ${plan.outsideHours}건`}
              </dd>
            </div>
          </dl>

          {imp.hasTime && (
            <div className="lab-row">
              <label>
                계산할 하루
                <select value={basis} onChange={(e) => setBasis(e.target.value as DayBasis)} disabled={busy}>
                  <option value="AVERAGE">평균 하루 ({Object.keys(imp.byDate).length}일)</option>
                  {WEEKDAYS.filter((w) => plan.weekdayDays[w]).map((w) => (
                    <option key={w} value={w}>
                      {WEEKDAY_LABEL[w]}요일 평균 ({plan.weekdayDays[w]}일){plan.busiestWeekday === w ? ' · 가장 바쁨' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                바쁜 시간 시작
                <select
                  value={plan.peak?.start ?? ''}
                  disabled={busy}
                  onChange={(e) => {
                    const start = e.target.value
                    const end = plan.peak && plan.peak.end > start ? plan.peak.end : edges[edges.indexOf(start) + 1]
                    setPeak({ start, end })
                  }}
                >
                  {edges.slice(0, -1).map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              <label>
                바쁜 시간 끝
                <select
                  value={plan.peak?.end ?? ''}
                  disabled={busy}
                  onChange={(e) => setPeak({ start: plan.peak?.start ?? edges[0], end: e.target.value })}
                >
                  {edges.filter((t) => !plan.peak || t > plan.peak.start).map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
              </label>
              {peak && (
                <button type="button" className="button secondary" onClick={() => setPeak(null)}>
                  자동으로 되돌리기
                </button>
              )}
            </div>
          )}
          <div className="lab-row">
            <label>
              파일에 담긴 결제 비율 (%)
              <input value={cardShare} inputMode="numeric" disabled={busy} onChange={(e) => setCardShare(e.target.value.replace(/\D/g, ''))} />
              {shareProblem && <small className="lab-error">{shareProblem}</small>}
            </label>
            <small className="lab-muted lab-hint">
              카드 승인 내역에는 현금·모바일쿠폰 결제가 빠져 있어요. 그런 결제가 전체의 15% 정도라면 85로 적으면 주문 수를 그만큼
              늘려요. 모르면 100(보정 안 함)으로 두세요.
            </small>
          </div>

          <div className="lab-totals">
            <div>
              <small>하루 주문</small>
              <b>{plan.dailyOrders}건</b>
            </div>
            <div>
              <small>영업시간</small>
              <b>{plan.open ? `${plan.open}~${plan.close}` : '07:00~19:00 (기본)'}</b>
            </div>
            <div>
              <small>바쁜 시간</small>
              <b>
                {plan.peak ? `${plan.peak.start}~${plan.peak.end}` : '11:00~14:00 (기본)'}
                {plan.peak && !peak && <small> 자동</small>}
              </b>
            </div>
            <div>
              <small>기준</small>
              <b>{imp.hasTime ? basisLabel(basis) : '파일 합계'}</b>
            </div>
          </div>

          {slots.length > 0 && (
            <div className="lab-bars" role="img" aria-label="시간대별 주문 수">
              {slots.map(([label, n]) => (
                <div key={label} className={inPeak(label) ? 'lab-bar peak' : 'lab-bar'}>
                  <span style={{ height: `${(n / maxSlot) * 100}%` }} />
                  <b>{n}</b>
                  <small>{label.slice(0, 2)}시</small>
                </div>
              ))}
            </div>
          )}

          {plan.menus.length > 0 && (
            <table className="lab-menus">
              <thead>
                <tr>
                  <th>파일 메뉴</th>
                  <th>{imp.hasTime ? '하루 평균' : '합계'}</th>
                  <th>만드는 방식(유형)</th>
                  <th>제조</th>
                </tr>
              </thead>
              <tbody>
                {plan.menus.map((m) => (
                  <tr key={m.name} className={m.how === 'GUESS' && !m.chosen ? 'lab-need' : ''}>
                    <td>{m.name}</td>
                    <td>{m.cups}잔</td>
                    <td>
                      <select
                        value={m.menuId ?? ''}
                        disabled={busy}
                        onChange={(e) => setMapping({ ...mapping, [m.name]: e.target.value || null })}
                      >
                        <option value="">빼고 계산 (음료 아님 등)</option>
                        {MENU_TYPES.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.label}
                          </option>
                        ))}
                      </select>
                      <small className={`lab-tag ${m.chosen ? 'owner' : m.how.toLowerCase()}`}>{m.chosen ? '직접 고름' : HOW_TEXT[m.how]}</small>
                    </td>
                    <td>{m.menuId ? `${makeSec[m.menuId] ?? typeSeconds(m.menuId)}초` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {aiNote && <p className="lab-muted">{aiNote}</p>}
          {plan.menuCups && (
            <table className="lab-menus lab-types">
              <thead>
                <tr>
                  <th>계산에 쓰는 유형</th>
                  <th>하루 잔 수</th>
                  <th>잔당 제조 시간(초)</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(plan.menuCups).map(([id, n]) => (
                  <tr key={id}>
                    <td>{imp.hasMenu ? typeLabel(id) : menuName(id)}</td>
                    <td>{n}잔</td>
                    <td>
                      <input
                        value={makeSec[id] ?? String(typeSeconds(id) ?? '')}
                        inputMode="numeric"
                        disabled={busy}
                        onChange={(e) => setMakeSec({ ...makeSec, [id]: e.target.value.replace(/\D/g, '') })}
                      />
                      {id in makeSec ? <small className="lab-tag owner">직접 고침</small> : <small className="lab-tag keyword">유형 기본값</small>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {makeProblem && <p className="lab-error">{makeProblem}</p>}

          <div className="lab-defaults">
            <b>기본값으로 채운 것</b>
            <ul>
              {plan.defaults.map((d) => (
                <li key={d}>{d}</li>
              ))}
              <li>주문 1건 = 음료 1잔으로 봐요(메뉴 열이 있으면 수량을 잔 수로).</li>
            </ul>
          </div>
          {plan.problems.length > 0 && (
            <ul className="lab-problems" role="alert">
              {plan.problems.map((p) => (
                <li key={p} className={stops.includes(p) ? 'stop' : ''}>
                  {p}
                </li>
              ))}
            </ul>
          )}

          <div className="lab-row">
            <label>
              사장님도 일하시나요?
              <select value={owner ? 'yes' : 'no'} onChange={(e) => setOwner(e.target.value === 'yes')} disabled={busy}>
                <option value="yes">네, 같이 일해요 (사장님 + 직원 1명)</option>
                <option value="no">아니요, 직원만 (직원 2명)</option>
              </select>
            </label>
            <label>
              직원 시급 (원)
              <input value={wage} inputMode="numeric" disabled={busy} onChange={(e) => setWage(e.target.value.replace(/\D/g, ''))} />
              {wageProblem && <small className="lab-error">{wageProblem}</small>}
            </label>
          </div>
          <div className="lab-row">
            <label>
              에스프레소 머신
              <select value={espresso} disabled={busy} onChange={(e) => setEspresso(Number(e.target.value))}>
                {MACHINE_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}대{n === 1 ? ' (기본)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              블렌더
              <select value={blenders} disabled={busy} onChange={(e) => setBlenders(Number(e.target.value))}>
                {MACHINE_COUNTS.map((n) => (
                  <option key={n} value={n}>
                    {n}대{n === 1 ? ' (기본)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <label>
              목표 대기 (주문 후 받기, 10명 중 9명)
              <select value={targetWait} disabled={busy} onChange={(e) => setTargetWait(Number(e.target.value))}>
                {TARGET_WAIT_MINUTES.map((m) => (
                  <option key={m} value={m * 60}>
                    {m}분 이내{m * 60 === DEFAULT_TARGET_WAIT_SEC ? ' (기본)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <small className="lab-muted lab-hint">
              목표를 짧게 잡으면 근무표가 사람을 더 넣어요. 머신이 늘면 스팀도 같은 수로 봐요.
            </small>
          </div>
          <button
            type="button"
            className="button primary lab-run"
            disabled={busy || stops.length > 0 || Boolean(wageProblem) || Boolean(shareProblem) || Boolean(makeProblem)}
            onClick={() => void run()}
          >
            확인했어요 · 저장하고 하루 근무표와 추천 근무표까지 한 번에
          </button>
          {status && (
            <p className="lab-status" role="status">
              {status}…
            </p>
          )}
          {runError && (
            <p className="lab-error" role="alert">
              {runError}
            </p>
          )}
        </section>
      )}


      {imp && plan && !stops.length && !wageProblem && !shareProblem && !makeProblem && (
        <RosterCard
          key={`${imp.fileName}:${plan.open}:${plan.close}:${espresso}:${blenders}:${targetWait}`}
          form={draftBody(formFromPlan(imp, plan, { isOwnerWorking: owner, hourlyWage: wageNumber }, equipment, manufacture))}
          ownerWorking={owner}
          open={plan.open ?? DEFAULT_OPEN}
          close={plan.close ?? DEFAULT_CLOSE}
          disabled={busy}
          autoRun={autoRun}
          onAutoDone={() => setWeekRun((n) => n + 1)}
        />
      )}

      {imp && plan && imp.hasTime && !stops.length && !wageProblem && !shareProblem && !makeProblem && (
        <WeeklyCard
          key={`week:${imp.fileName}:${plan.open}:${plan.close}`}
          weekdays={WEEKDAYS.filter((w) => plan.weekdayDays[w])}
          planFor={(day) => planFrom(imp, day, null, mapping, shareNumber / 100, aiTypes)}
          formFor={(p) => draftBody(formFromPlan(imp, p, { isOwnerWorking: owner, hourlyWage: wageNumber }, equipment, manufacture))}
          ownerWorking={owner}
          wage={wage}
          disabled={busy}
          autoRun={weekRun}
          saved={saved}
          open={plan.open ?? DEFAULT_OPEN}
          close={plan.close ?? DEFAULT_CLOSE}
          team={team ?? exampleTeam(wage, open, close, dataDays)}
          onTeam={setTeam}
          onOptions={(data, summary) => void onOptions(data, summary)}
        />
      )}

    </div>
  )
}
