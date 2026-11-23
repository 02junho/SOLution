import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { loadOperationTrace } from '../../../api/operationApi'
import { Alert, Icon, Modal } from '../../../components/common/Ui'
import type { OperationPlan } from '../../../types/api'
import QueueReplay from '../QueueReplay'
import type { OperationResult, OperationTrace, PlanSummary, Shift, TraceRef } from '../types'
import {
  CHOICE_KEYS,
  CHOICE_TITLE,
  TASK_LABEL,
  WORKER_LABEL,
  diffText,
  duration,
  hourOf,
  hours,
  minutes,
  percent,
  pos,
  span,
  won,
} from './format'
import { MENUS, SLOT_KEYS, hoursText, readOperationInput, rushText, slotLabel } from './operationInput'
import type { JsonObject } from '../../../types/workflow'
import './operationWorkspace.css'

/*
 * 운영 실험 · 세 안 자세히 비교 (넓은 화면). 02 결과 칸은 요약과 확정만 두고, 자세한 비교는 여기서 본다.
 * 숫자는 Spring 결과(summary)·상세(detail)를 그대로 쓰고 화면에서 다시 계산하지 않는다.
 * 대기열 재생은 공용 QueueReplay(features/operation)를 가져다 쓰고, 정리표 PDF는 브라우저 인쇄(PDF로 저장)로 만든다.
 */

type Stat = { mean: number | null }
type SlotRow = { slot: string; metrics: Record<string, Stat | undefined> }
export type EngineChoice = {
  choice_key: OperationPlan
  quality_pass_rate?: number | null
  passes_quality_targets?: boolean | null
  by_slot?: SlotRow[]
}
type WorkerCost = { worker_key: string; paid_seconds: number; base_wage_krw: number; cash_cost_krw: number }
export type Detail = {
  schedule?: { plans?: { choice_key: OperationPlan; schedule: Shift[] }[]; worker_context?: Record<string, { is_owner: boolean }> }
  labor?: {
    plans?: { choice_key: OperationPlan; workers?: WorkerCost[]; employee_paid_seconds?: number }[]
    minimum_hourly_wage_krw?: number
    wage_year?: number
  }
  simulation_choices?: EngineChoice[]
  trace_refs?: TraceRef[]
}

const SLOT_LABEL = (slot: string) => slot.replaceAll(':00', '').replace('-', '~') + '시'

function PlanCard({
  plan,
  engine,
  recommended,
  fastest,
  selected,
  disabled,
  onSelect,
}: {
  plan: PlanSummary
  engine: EngineChoice | undefined
  recommended: boolean
  fastest: boolean
  selected: boolean
  disabled: boolean
  onSelect: () => void
}) {
  const m = plan.metrics
  const c = plan.comparison
  return (
    <div className={`opw-plan-card ${selected ? 'selected' : ''}`}>
      <button type="button" role="radio" aria-checked={selected} disabled={disabled} className="opw-plan-pick" onClick={onSelect}>
        <div className="choice-top">
          <span className="opw-tags">
            {recommended && <span className="status-pill green">추천</span>}
            {fastest && <span className="status-pill">가장 빠름</span>}
          </span>
          <span className="radio-dot">{selected && <Icon name="check" size={12} />}</span>
        </div>
        <h3>{CHOICE_TITLE[plan.choice_key]}</h3>
        <small>주문 후 음료 받기까지 평균</small>
        <strong className="opw-big">{minutes(m.post_order_wait_mean_seconds)}</strong>
        <dl className="opw-rows">
          <div>
            <dt>목표 달성 (30번 중)</dt>
            <dd>{engine ? percent(engine.quality_pass_rate) : '…'}</dd>
          </div>
          <div>
            <dt>5분 넘게 기다린 손님</dt>
            <dd>{percent(m.post_order_wait_over_300_ratio)}</dd>
          </div>
          <div>
            <dt>하루 직원 인건비</dt>
            <dd>{won(plan.cash_cost_krw)}</dd>
          </div>
          <div>
            <dt>현재 대비 추가</dt>
            <dd>{plan.choice_key === 'CURRENT' ? '기준' : won(plan.additional_cash_cost_krw)}</dd>
          </div>
        </dl>
      </button>
      <details className="opw-more">
        <summary>숫자 더 보기</summary>
        <dl className="opw-rows">
          <div>
            <dt>총소요 평균 (도착 → 받음)</dt>
            <dd>{minutes(m.total_time_mean_seconds)}</dd>
          </div>
          <div>
            <dt>손님 90%가 받기까지 걸린 총시간 (도착 → 받음)</dt>
            <dd>{minutes(m.total_time_p90_seconds)}</dd>
          </div>
          <div>
            <dt>주문 줄 평균 대기</dt>
            <dd>{duration(m.order_queue_wait_mean_seconds)}</dd>
          </div>
          <div>
            <dt>현재 대비 수령 시간 (95% 범위)</dt>
            <dd>
              {plan.choice_key === 'CURRENT' || !c
                ? '기준'
                : diffText(c.delta_vs_current_seconds, c.ci95_lower_seconds, c.ci95_upper_seconds)}
            </dd>
          </div>
          <div>
            <dt>30번 중 더 빨랐던 횟수</dt>
            <dd>{plan.choice_key === 'CURRENT' || !c ? '—' : `${c.better_count}번`}</dd>
          </div>
        </dl>
      </details>
    </div>
  )
}

type WorkerRow = { worker_key: string; shifts: Shift[]; start: string; end: string }
/** 같은 사람의 근무 조각(업무가 바뀌는 구간)을 한 줄로 묶는다. 사장님 → 직원 순서. */
function groupByWorker(shifts: Shift[]): WorkerRow[] {
  const rows = new Map<string, Shift[]>()
  for (const s of shifts) rows.set(s.worker_key, [...(rows.get(s.worker_key) ?? []), s])
  return [...rows.entries()]
    .map(([worker_key, list]) => {
      const sorted = [...list].sort((a, b) => a.start_time.localeCompare(b.start_time))
      return { worker_key, shifts: sorted, start: sorted[0].start_time, end: sorted[sorted.length - 1].end_time }
    })
    .sort((a, b) => (a.worker_key === 'OWNER' ? -1 : b.worker_key === 'OWNER' ? 1 : a.worker_key.localeCompare(b.worker_key)))
}
/** 근무 구간에서 휴게를 뺀 조각들. 휴게는 따로 회색으로 그린다. */
function workPieces(shift: Shift) {
  const pieces: { start: number; end: number }[] = []
  let cursor = hourOf(shift.start_time)
  for (const b of [...shift.breaks].sort((x, y) => x.start_time.localeCompare(y.start_time))) {
    if (hourOf(b.start_time) > cursor) pieces.push({ start: cursor, end: hourOf(b.start_time) })
    cursor = Math.max(cursor, hourOf(b.end_time))
  }
  if (hourOf(shift.end_time) > cursor) pieces.push({ start: cursor, end: hourOf(shift.end_time) })
  return pieces
}
const taskSummary = (row: WorkerRow) =>
  row.shifts.length === 1
    ? (TASK_LABEL[row.shifts[0].task_code] ?? row.shifts[0].task_code)
    : row.shifts
        .map((s) => `${s.start_time.slice(0, 5)}-${s.end_time.slice(0, 5)} ${TASK_LABEL[s.task_code] ?? s.task_code}`)
        .join(' · ')

function DaySchedule({ choice, detail, plan }: { choice: OperationPlan; detail: Detail; plan: PlanSummary }) {
  const shifts = detail.schedule?.plans?.find((p) => p.choice_key === choice)?.schedule ?? []
  const costs = detail.labor?.plans?.find((p) => p.choice_key === choice)?.workers ?? []
  const owners = detail.schedule?.worker_context ?? {}
  const rows = groupByWorker(shifts)
  const hasBreak = shifts.some((s) => s.breaks.length > 0)
  const hasHelp = shifts.some((s) => s.task_code.includes('_HELP_'))
  return (
    <section className="opw-card">
      <div className="section-heading">
        <Icon name="clock" size={18} />
        <h3>{CHOICE_TITLE[choice]} 하루 배치표</h3>
      </div>
      <p className="muted">계획 배치표예요. 법정 휴게를 넣었고, 대기시간 계산에는 휴게를 반영하지 않았어요.</p>
      {rows.length ? (
        <div className="opw-gantt">
          <div className="opw-axis">
            {[7, 9, 11, 13, 15, 17, 19].map((h) => (
              <span key={h} style={{ left: pos(h) }}>
                {String(h).padStart(2, '0')}
              </span>
            ))}
          </div>
          {rows.map((row) => {
            const owner = owners[row.worker_key]?.is_owner ?? row.worker_key === 'OWNER'
            const cost = costs.find((w) => w.worker_key === row.worker_key)
            return (
              <div key={row.worker_key} className="opw-gantt-row">
                <span>{WORKER_LABEL[row.worker_key] ?? row.worker_key}</span>
                <div className="opw-track">
                  {row.shifts.flatMap((s, i) =>
                    workPieces(s).map((p, j) => (
                      <i
                        key={`${i}-${j}`}
                        className={`${owner ? 'owner' : ''} ${s.task_code.includes('_HELP_') ? 'help' : ''}`}
                        title={`${s.start_time}~${s.end_time} ${TASK_LABEL[s.task_code] ?? s.task_code}`}
                        style={{ left: pos(p.start), width: span(p.start, p.end) }}
                      />
                    )),
                  )}
                  {row.shifts.flatMap((s, i) =>
                    s.breaks.map((b, j) => (
                      <i
                        key={`b${i}-${j}`}
                        className="break"
                        title={`휴게 ${b.start_time}~${b.end_time}`}
                        style={{ left: pos(hourOf(b.start_time)), width: span(hourOf(b.start_time), hourOf(b.end_time)) }}
                      />
                    )),
                  )}
                </div>
                <small>
                  {row.start}~{row.end} · {taskSummary(row)}
                  {owner ? ' · 급여 제외' : cost ? ` · 유급 ${hours(cost.paid_seconds)} · ${won(cost.cash_cost_krw)}` : ''}
                </small>
              </div>
            )
          })}
          <div className="opw-legend">
            <span className="status-pill">근무</span>
            {hasHelp && <span className="status-pill opw-help">서로 돕는 시간</span>}
            {rows.some((r) => owners[r.worker_key]?.is_owner ?? r.worker_key === 'OWNER') && (
              <span className="status-pill opw-owner">사장님</span>
            )}
            {hasBreak && <span className="status-pill opw-break">휴게 (무급)</span>}
          </div>
        </div>
      ) : (
        <p className="muted">배치표가 없어요.</p>
      )}
      <dl className="opw-rows opw-total">
        <div>
          <dt>하루 직원 인건비 (기본급)</dt>
          <dd>{won(plan.cash_cost_krw)}</dd>
        </div>
        {typeof plan.owner_work_seconds === 'number' && plan.owner_work_seconds > 0 && (
          <div>
            <dt>사장님 근무 (급여 제외)</dt>
            <dd>{hours(plan.owner_work_seconds)}</dd>
          </div>
        )}
        {detail.labor?.minimum_hourly_wage_krw && (
          <div>
            <dt>{detail.labor.wage_year}년 최저시급</dt>
            <dd>{won(detail.labor.minimum_hourly_wage_krw)}</dd>
          </div>
        )}
      </dl>
    </section>
  )
}

/** 고른 안의 1번째 반복 재생. 화면은 공용 QueueReplay를 그대로 쓰고, 기록은 Spring 재생 API에서 읽는다. */
function Replay({ resultId, reference }: { resultId: number; reference: TraceRef | undefined }) {
  // 불러온 기록을 log_id와 함께 둔다. 안을 바꾸면 log_id가 달라져 "불러오는 중"으로 보이고,
  // effect 안에서는 비동기 응답이 왔을 때만 상태를 바꾼다(effect에서 바로 setState하지 않음).
  const [loaded, setLoaded] = useState<{ logId: number; trace: OperationTrace | null; error: string } | null>(null)
  const logId = reference?.log_id
  useEffect(() => {
    if (logId === undefined) return
    const controller = new AbortController()
    void loadOperationTrace(resultId, logId, controller.signal).then((response) => {
      if (controller.signal.aborted) return
      setLoaded(
        response.status === 'ok' && response.data
          ? { logId, trace: response.data, error: '' }
          : { logId, trace: null, error: response.message ?? '재생 기록을 불러오지 못했어요.' },
      )
    })
    return () => controller.abort()
  }, [resultId, logId])
  const current = loaded && loaded.logId === logId ? loaded : null
  const trace = current?.trace ?? null
  const error = current?.error ?? ''
  return (
    <section className="opw-card opw-replay-card">
      <div className="section-heading">
        <Icon name="refresh" size={18} />
        <h3>대기열 다시 보기</h3>
      </div>
      {!reference ? (
        <p className="muted">이 결과에는 재생 기록이 없어요.</p>
      ) : error ? (
        <Alert error>{error}</Alert>
      ) : trace ? (
        <>
          <p className="muted">
            30번 중 첫 번째 반복 하나를 보여 줘요. 위 숫자(30번 평균)와 다를 수 있어요.
          </p>
          <div className="opw-replay">
            <QueueReplay key={logId} trace={trace} />
          </div>
        </>
      ) : (
        <p className="muted">재생 기록을 불러오는 중이에요…</p>
      )}
    </section>
  )
}

function SlotTable({ engines }: { engines: EngineChoice[] }) {
  const slots = engines[0]?.by_slot ?? []
  if (!slots.length) return null
  return (
    <section className="opw-card">
      <div className="section-heading">
        <Icon name="clock" size={18} />
        <h3>시간대별: 손님 90%가 주문 후 받기까지 걸린 시간</h3>
      </div>
      <div className="table-scroll">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>시간대</th>
              {CHOICE_KEYS.map((k) => (
                <th key={k}>{CHOICE_TITLE[k]}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slots.map((row, i) => (
              <tr key={row.slot}>
                <td>
                  {SLOT_LABEL(row.slot)}
                  <small> 손님 {Math.round(row.metrics.arrived_in_slot?.mean ?? 0)}명</small>
                </td>
                {CHOICE_KEYS.map((k) => {
                  const p90 = engines.find((e) => e.choice_key === k)?.by_slot?.[i]?.metrics.p90_post_order_receipt_sec?.mean
                  return (
                    <td key={k} className={typeof p90 === 'number' && p90 > 300 ? 'opw-over' : ''}>
                      {minutes(p90)}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted">목표는 주문 후 받기까지 90%가 5분 이내예요. 손님이 10명 미만인 시간대는 참고만 해 주세요.</p>
    </section>
  )
}


const dateText = () => new Date().toLocaleDateString('ko-KR')

/** 운영안 정리표(인쇄·PDF 저장용). 화면에서는 숨기고 인쇄할 때만 이 묶음이 보인다. */
function ReportSheet({
  result,
  detail,
  input,
  choice,
  confirmed,
}: {
  result: OperationResult
  detail: Detail | null
  input: JsonObject | null
  choice: OperationPlan
  confirmed: boolean
}) {
  const summary = result.summary
  const plans = CHOICE_KEYS.map((k) => summary.choices?.find((p) => p.choice_key === k)).filter(
    (p): p is PlanSummary => Boolean(p),
  )
  const saved = readOperationInput(input)
  const shifts = detail?.schedule?.plans?.find((p) => p.choice_key === choice)?.schedule ?? []
  const rows = groupByWorker(shifts)
  const costs = detail?.labor?.plans?.find((p) => p.choice_key === choice)?.workers ?? []
  const picked = plans.find((p) => p.choice_key === choice)
  const engines = detail?.simulation_choices ?? []
  const menus = saved?.menuIds.length
    ? saved.menuIds
        .map((id) => {
          const name = MENUS.find((m) => m.menu_id === id)?.menu_name ?? id
          const weight = saved.weights[id]
          return typeof weight === 'number' ? `${name} ${Math.round(weight * 100)}%` : name
        })
        .join(', ')
    : '기본 메뉴 5종'
  return (
    <div className="opw-print-root">
      <article className="opw-print">
        <header>
          <h1>운영안 정리표</h1>
          <p>
            {confirmed ? `확정: ${CHOICE_TITLE[choice]}` : `비교용 (확정 전) · 고른 안: ${CHOICE_TITLE[choice]}`} · 만든 날{' '}
            {dateText()}
          </p>
          <p className="opw-print-warn">모의 조건: 가정에 근거한 값이며 실제 매장과 다를 수 있어요.</p>
        </header>
        <h2>1. 조건</h2>
        <table>
          <tbody>
            <tr>
              <th>주문</th>
              <td>
                {saved
                  ? saved.slotOrders
                    ? `하루 ${saved.dailyOrders}건 (${saved.slotOrders.map((n, i) => `${slotLabel(SLOT_KEYS[i])} ${n}건`).join(', ')} · 을지로입구 상권 비중)`
                    : `하루 ${saved.dailyOrders}건 (영업 ${hoursText(saved.hours)} · 을지로입구 상권 비중을 영업시간에 맞춰 나눔)`
                  : '—'}
              </td>
            </tr>
            <tr>
              <th>라스트 오더 / 바쁜 시간</th>
              <td>
                {saved
                  ? `${saved.chosenLastOrder ?? `기본 ${saved.lastOrderTime}`} / ${rushText(saved.rush)} (상권 데이터의 가장 바쁜 시간대. 서로 돕기·한 명 추가 적용, 휴게 피함)`
                  : '—'}
              </td>
            </tr>
            <tr>
              <th>처리시간</th>
              <td>{saved ? `주문 ${saved.orderSec}±15초 · 전달 ${saved.handoffSec}±10초 · 제조는 메뉴별 (가정)` : '—'}</td>
            </tr>
            <tr>
              <th>메뉴·판매 비중</th>
              <td>{menus}</td>
            </tr>
            <tr>
              <th>직원</th>
              <td>
                {saved
                  ? `${saved.isOwnerWorking ? '사장님 + 직원 1명' : '직원 2명'} · ${hoursText(saved.hours)} · 시급 ${won(saved.hourlyWage)}`
                  : '—'}
              </td>
            </tr>
            <tr>
              <th>반복</th>
              <td>{summary.completed_repetitions ?? 30}회 (세 안이 같은 손님 조건 사용)</td>
            </tr>
          </tbody>
        </table>
        <h2>2. 세 안 비교</h2>
        <table>
          <thead>
            <tr>
              <th>안</th>
              <th>주문 후 수령 평균</th>
              <th>총소요 평균</th>
              <th>손님 90% 총시간</th>
              <th>5분 넘게 기다린 손님</th>
              <th>목표 달성</th>
              <th>하루 인건비</th>
              <th>현재 대비 추가</th>
            </tr>
          </thead>
          <tbody>
            {plans.map((p) => (
              <tr key={p.choice_key} className={p.choice_key === choice ? 'picked' : ''}>
                <td>
                  {CHOICE_TITLE[p.choice_key]}
                  {p.choice_key === choice ? ' ✓' : ''}
                </td>
                <td>{minutes(p.metrics.post_order_wait_mean_seconds)}</td>
                <td>{minutes(p.metrics.total_time_mean_seconds)}</td>
                <td>{minutes(p.metrics.total_time_p90_seconds)}</td>
                <td>{percent(p.metrics.post_order_wait_over_300_ratio)}</td>
                <td>{percent(engines.find((e) => e.choice_key === p.choice_key)?.quality_pass_rate)}</td>
                <td>{won(p.cash_cost_krw)}</td>
                <td>{p.choice_key === 'CURRENT' ? '기준' : won(p.additional_cash_cost_krw)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {summary.recommendation?.reason && <p className="opw-print-note">{summary.recommendation.reason}</p>}
        <h2>3. {CHOICE_TITLE[choice]} 하루 배치표</h2>
        {rows.length ? (
          <table>
            <thead>
              <tr>
                <th>사람</th>
                <th>근무</th>
                <th>맡은 일</th>
                <th>휴게 (무급)</th>
                <th>유급</th>
                <th>인건비</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const owner = detail?.schedule?.worker_context?.[row.worker_key]?.is_owner ?? row.worker_key === 'OWNER'
                const cost = costs.find((w) => w.worker_key === row.worker_key)
                const rests = row.shifts.flatMap((s) => s.breaks).map((b) => `${b.start_time}~${b.end_time}`).join(', ')
                return (
                  <tr key={row.worker_key}>
                    <td>{WORKER_LABEL[row.worker_key] ?? row.worker_key}</td>
                    <td>
                      {row.start}~{row.end}
                    </td>
                    <td>{taskSummary(row)}</td>
                    <td>{rests || '없음'}</td>
                    <td>{owner ? '급여 제외' : hours(cost?.paid_seconds)}</td>
                    <td>{owner ? '—' : won(cost?.cash_cost_krw)}</td>
                  </tr>
                )
              })}
            </tbody>
            {picked && (
              <tfoot>
                <tr>
                  <th colSpan={5}>합계</th>
                  <td>{won(picked.cash_cost_krw)}</td>
                </tr>
              </tfoot>
            )}
          </table>
        ) : (
          <p>배치표가 없어요.</p>
        )}
        <h2>4. 알아 둘 점</h2>
        <ul>
          <li>실제 매장에서 잰 값이 아니라 가정한 처리시간과 손님 수로 30번 돌린 모의 결과예요. 숫자보다 세 안의 차이를 보세요.</li>
          <li>배치표는 계획표예요. 휴게는 배치표에만 넣었고 대기시간 계산에는 넣지 않았어요.</li>
          <li>인건비는 기본급만이에요. 주휴수당·4대보험은 빠져 있어요. 근무표 앱 적용이나 채용은 하지 않아요.</li>
          <li>출처: 시간대 비중은 서울시 상권분석서비스(을지로입구 커피 상권, 카드결제 건수), 최저시급은 고용노동부 고시.</li>
        </ul>
      </article>
    </div>
  )
}

export default function OperationReport({
  result,
  detail,
  detailError,
  onRetryDetail,
  input,
  selected,
  recommended,
  fastest,
  confirmed,
  locked,
  onSelect,
  onClose,
}: {
  result: OperationResult
  detail: Detail | null
  detailError: string
  onRetryDetail: () => void
  input: JsonObject | null
  selected: OperationPlan
  recommended: OperationPlan | null
  fastest: OperationPlan | undefined
  confirmed: boolean
  locked: boolean
  onSelect: (choice: OperationPlan) => void
  onClose: () => void
}) {
  const summary = result.summary
  const plans = CHOICE_KEYS.map((k) => summary.choices?.find((p) => p.choice_key === k)).filter(
    (p): p is PlanSummary => Boolean(p),
  )
  const engines = detail?.simulation_choices ?? []
  const plan = plans.find((p) => p.choice_key === selected) ?? plans[0]
  const notes = (summary.warnings ?? []).filter((w) => !w.requires_ack)
  return (
    <Modal
      title="세 운영안 자세히 비교"
      description={`${summary.comparison_window ? `${summary.comparison_window.start_time}~${summary.comparison_window.end_time}` : '07~19시'} · 같은 손님 조건으로 ${summary.completed_repetitions ?? 30}번 돌린 결과예요. 고른 안의 배치표와 대기열을 아래에서 봐요.`}
      wide
      closeOnBackdrop
      onClose={onClose}
    >
      <div className="opw-wide">
        <div className="opw-report-head">
          <span className="status-pill opw-sim">모의 조건</span>
          <p>
            {summary.recommendation?.reason ??
              notes.find((w) => w.warning_id === 'NO_FEASIBLE_PLAN')?.message ??
              '세 안을 비교한 뒤 직접 선택해 주세요.'}
          </p>
        </div>
        <div className="opw-plan-grid" role="radiogroup" aria-label="운영안 선택">
          {plans.map((p) => (
            <PlanCard
              key={p.choice_key}
              plan={p}
              engine={engines.find((e) => e.choice_key === p.choice_key)}
              recommended={p.choice_key === recommended}
              fastest={p.choice_key === fastest}
              selected={p.choice_key === selected}
              disabled={locked}
              onSelect={() => onSelect(p.choice_key)}
            />
          ))}
        </div>
        {!detail && detailError ? (
          <Alert error>
            {detailError}{' '}
            <button type="button" className="text-button" onClick={onRetryDetail}>
              다시 불러오기
            </button>
          </Alert>
        ) : !detail ? (
          <p className="muted">배치표·시간대·재생 기록을 불러오는 중이에요…</p>
        ) : (
          <>
            <SlotTable engines={engines} />
            {plan && (
              <div className="opw-two">
                <Replay
                  resultId={result.result_id}
                  reference={detail.trace_refs?.find((ref) => ref.choice_key === plan.choice_key)}
                />
                <DaySchedule choice={plan.choice_key} detail={detail} plan={plan} />
              </div>
            )}
          </>
        )}
        {(summary.assumptions?.length ?? 0) > 0 && (
          <details className="opw-assumptions">
            <summary>계산에 쓴 가정</summary>
            <ul>
              {summary.assumptions?.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
          </details>
        )}
        <div className="modal-footer">
          <button
            type="button"
            className="button secondary"
            disabled={!detail}
            onClick={() => window.print()}
            title="인쇄 창에서 'PDF로 저장'을 고르면 파일로 받을 수 있어요"
          >
            정리표 PDF
          </button>
          <button type="button" className="button primary" onClick={onClose}>
            {confirmed ? '닫기' : `${CHOICE_TITLE[selected]} 고르고 닫기`}
            <Icon name="check" size={16} />
          </button>
        </div>
      </div>
      {createPortal(
        <ReportSheet result={result} detail={detail} input={input} choice={selected} confirmed={confirmed} />,
        document.body,
      )}
    </Modal>
  )
}
