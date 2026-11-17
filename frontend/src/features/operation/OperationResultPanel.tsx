import { useState } from 'react'
import type { ApiResponse, OperationPlan } from '../../types/api'
import QueueReplay from './QueueReplay'
import { CHOICE_LABELS } from './types'
import type { OperationResult, OperationTrace, PlanSummary, TraceRef } from './types'

const numeric = (value: number | null | undefined, suffix = '') => value == null ? '미확인' : `${value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}${suffix}`
const minutes = (value: number | null | undefined) => value == null ? '미확인' : `${(value / 60).toFixed(1)}분`
const tasks: Record<string, string> = { ALL_TASKS: '전체 업무', ORDER_HANDOFF: '주문·전달', PREPARATION: '제조', ORDER_HANDOFF_HELP_PREPARATION: '주문·전달 우선, 제조 도움', PREPARATION_HELP_ORDER_HANDOFF: '제조 우선, 주문·전달 도움' }
const roleLabels: Record<string, string> = { ORDER: '주문', MAKE: '제조·전달', FLEX: '유동 지원' }
const assignmentLabel = (row: { task_code: string; primary_role?: string | null; can_support?: string[] }) => row.primary_role
  ? `${roleLabels[row.primary_role] ?? row.primary_role}${row.can_support?.length ? ` 우선 · ${row.can_support.map(x => roleLabels[x] ?? x).join('·')} 지원 가능` : ''}`
  : tasks[row.task_code] ?? row.task_code
const metricLabels: Record<string, string> = { order_queue_wait_mean_seconds: '주문 줄 평균 대기', post_order_wait_mean_seconds: '주문 후 수령 평균', total_time_mean_seconds: '총 소요 평균', total_time_p90_seconds: '총 소요 p90' }

type Props = {
  result: OperationResult
  preview?: boolean
  loadingDetail: boolean
  onDetail: () => void
  trace: OperationTrace | null
  loadingTrace: boolean
  onTrace: (ref: TraceRef) => void
  onConfirm?: (choice: OperationPlan, ids: string[]) => Promise<ApiResponse<{ confirmation_id: number; is_current_version: boolean }>>
}

export default function OperationResultPanel({ result, preview = false, loadingDetail, onDetail, trace, loadingTrace, onTrace, onConfirm }: Props) {
  const [selected, setSelected] = useState<OperationPlan | null>(result.confirmed_choice_key)
  const [acknowledged, setAcknowledged] = useState<string[]>([])
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const summary = result.summary
  const plans = summary.choices ?? []
  const warnings = summary.warnings ?? []
  const required = warnings.filter(w => w.requires_ack)
  // complete가 정확히 true일 때만 확정 버튼을 켠다. 없거나 다른 값이면 끈다 (API v0.4).
  const valid = result.response_status === 'ok' && result.is_latest_version && summary.complete === true
    && summary.completed_repetitions === 30 && summary.requested_repetitions === 30
    && !result.confirmed_choice_key && !saved
  async function confirm() {
    if (!selected || !onConfirm || preview) return
    setSaving(true); setMessage(null)
    try {
      const response = await onConfirm(selected, acknowledged)
      if (response.status === 'ok' && response.data) {
        setSaved(true)
        setMessage(response.data.is_current_version ? '선택한 운영안을 저장했습니다.' : '확정 이력은 저장됐지만 입력이 변경됐습니다. 최신 조건을 확인해 주세요.')
      } else setMessage(response.message ?? '확정을 완료하지 못했습니다.')
    } catch {
      setMessage('저장 응답을 확인하지 못했습니다. 같은 선택으로 다시 시도해 주세요.')
    } finally { setSaving(false) }
  }
  function toggle(id: string, checked: boolean) {
    setAcknowledged(current => checked ? [...new Set([...current, id])] : current.filter(value => value !== id))
  }
  return <>
    <section className="op-result-heading">
      <div><span className="op-eyebrow">점심 운영 비교</span><h1>몇 명을, 언제,<br />어떤 일에 쓸까요?</h1>
        <p>배치 계획을 먼저 보고, 같은 손님 조건의 대기와 비용을 비교하세요.</p></div>
      <div className="op-run-meta"><span className="op-tag">모의 조건</span>
        <strong>{summary.comparison_window?.start_time ?? '—'}–{summary.comparison_window?.end_time ?? '—'}</strong>
        <span>{summary.completed_repetitions ?? '—'} / {summary.requested_repetitions ?? '—'}회 완료</span></div>
    </section>
    {!result.is_latest_version && <p role="status" className="op-notice">조건이 바뀐 예전 결과입니다. 최신 입력으로 다시 계산해 주세요.</p>}
    {result.confirmed_choice_key && <p role="status" className="op-notice">확정한 안: {CHOICE_LABELS[result.confirmed_choice_key]}</p>}
    {result.response_status !== 'ok' ? <section className="op-surface" role="status">
      <h2>{result.response_status === 'needs_input' ? '계산 조건을 더 확인해야 합니다.' : '이 조건에서는 비교를 완료하지 못했습니다.'}</h2>
      <p>{summary.message ?? '입력 조건을 확인해 주세요.'}</p>
      <ul>{summary.missing_fields?.map(field => <li key={field.path}>{field.label}{field.unit && ` (${field.unit})`}</li>)}
        {summary.violations?.map((item, i) => <li key={i}>{item.message ?? item.code}</li>)}
        {summary.suggestions?.map(item => <li key={item}>{item}</li>)}</ul>
    </section> : <>
      <div className="op-section-title"><div><span className="op-eyebrow">01 · 인원과 역할</span><h2>세 가지 계획을 비교하세요</h2></div></div>
      <div className="op-card-grid">{plans.map(plan => <PlanCard key={plan.choice_key} plan={plan}
        recommended={summary.recommendation?.choice_key === plan.choice_key}
        selected={selected === plan.choice_key} onSelect={() => setSelected(plan.choice_key)} />)}</div>
      {summary.recommendation && <p className="op-recommendation">대기 지표 기준 추천: <strong>{CHOICE_LABELS[summary.recommendation.choice_key]}</strong> · {summary.recommendation.reason}<br />인건비는 별도로 비교하며, 최종 선택은 사장님이 합니다.</p>}
      <section className="op-surface op-detail-section">
        <div className="op-section-title"><div><span className="op-eyebrow">02 · 하루 계획과 근거</span><h2>전체 배치표 · 대기열 재생</h2></div>
          {!result.detail && <button className="op-secondary" onClick={onDetail} disabled={loadingDetail}>{loadingDetail ? '불러오는 중…' : '상세보기'}</button>}</div>
        {!result.detail ? <p className="op-muted">상세보기를 누르면 계획 배치표와 재생 가능한 기록을 불러옵니다.</p> : <>
          <div className="op-plan-tabs" role="group" aria-label="배치표 운영안">{plans.map(plan => <button key={plan.choice_key}
            className={selected === plan.choice_key ? '' : 'op-secondary'} onClick={() => setSelected(plan.choice_key)}>{CHOICE_LABELS[plan.choice_key]}</button>)}</div>
          <div className="op-table-scroll"><table><caption>{CHOICE_LABELS[selected ?? 'CURRENT']} 계획 배치표</caption>
            <thead><tr><th>시간</th><th>직원</th><th>담당 업무</th><th>휴게</th></tr></thead>
            <tbody>{result.detail.schedule.plans.find(p => p.choice_key === (selected ?? 'CURRENT'))?.schedule.map((row, i) => <tr key={`${row.worker_key}-${i}`}>
              <td>{row.start_time}–{row.end_time}</td><td>{result.detail?.schedule.worker_context?.[row.worker_key]?.is_owner || row.worker_key === 'OWNER' ? '사장님' : row.worker_key}</td>
              <td>{assignmentLabel(row)}</td><td>{row.breaks.length ? row.breaks.map(rest => `${rest.start_time}–${rest.end_time} (${rest.is_paid ? '유급' : '무급'})`).join(', ') : '없음'}</td></tr>)}</tbody>
          </table></div>
          <div className="op-trace-controls"><label>재생 기록 <select aria-label="재생 기록" value={trace?.log_id ?? ''}
            onChange={e => { const ref = result.detail?.trace_refs.find(r => r.log_id === Number(e.target.value)); if (ref) onTrace(ref) }}>
            <option value="">운영안·반복 선택</option>{result.detail.trace_refs.map(ref => <option key={ref.log_id} value={ref.log_id}>{CHOICE_LABELS[ref.choice_key]} · 반복 {ref.replication_no}{ref.is_complete ? '' : ' · 부분 기록'}</option>)}</select></label>
            <span className="op-muted">한 반복의 재생이며 비교 카드의 30회 평균과 구분합니다.</span></div>
          {loadingTrace ? <p role="status">재생 기록을 불러오는 중입니다…</p> : trace ? <QueueReplay key={trace.log_id} trace={trace} /> : <p className="op-muted">재생할 운영안과 반복을 선택해 주세요.</p>}
        </>}
      </section>
    </>}
    <section className="op-surface op-assumptions"><h2>선택 전에 확인해 주세요</h2>
      {warnings.map(warning => <div key={warning.warning_id} className="op-warning">
        {warning.requires_ack ? <label><input type="checkbox" checked={acknowledged.includes(warning.warning_id)} onChange={e => toggle(warning.warning_id, e.target.checked)} />{warning.message}</label> : <p>{warning.message}</p>}</div>)}
      {!!summary.assumptions?.length && <ul>{summary.assumptions.map(note => <li key={note}>{note}</li>)}</ul>}
      <div className="op-save-row"><div><strong>{selected ? `${CHOICE_LABELS[selected]} 선택` : '운영안을 선택해 주세요'}</strong>
        <p className="op-muted">{preview ? '미리보기에서는 저장하지 않습니다.' : '선택한 계획만 저장합니다. 실제 근무표를 적용하지 않습니다.'}</p></div>
        <button onClick={confirm} disabled={preview || !onConfirm || !valid || !selected || saving || required.some(w => !acknowledged.includes(w.warning_id))}>
          {saving ? '저장 중…' : saved || result.confirmed_choice_key ? '확정됨' : '이 안으로 확정'}</button></div>
      {message && <p role="status" className="op-notice">{message}</p>}
    </section>
  </>
}

function PlanCard({ plan, recommended, selected, onSelect }: { plan: PlanSummary; recommended: boolean; selected: boolean; onSelect: () => void }) {
  const comparison = plan.comparison
  const inconclusive = comparison && comparison.ci95_lower_seconds <= 0 && comparison.ci95_upper_seconds >= 0
  return <article className={`op-plan-card ${selected ? 'is-selected' : ''}`}>
    <div className="op-card-title"><h2>{CHOICE_LABELS[plan.choice_key]}</h2>{recommended && <span className="op-tag">대기 지표 추천</span>}</div>
    {plan.staffing_summary ? <div className="op-staffing-summary">
      <strong>{plan.staffing_summary.start_time}–{plan.staffing_summary.end_time} · 최대 {plan.staffing_summary.max_concurrent_workers}명</strong>
      <ul>{plan.staffing_summary.assignments.map((row, i) => <li key={`${row.worker_key}-${i}`}>
        <span>{row.is_owner || row.worker_key === 'OWNER' ? '사장님' : row.worker_key} · {row.start_time}–{row.end_time}</span>
        <b>{assignmentLabel(row)}</b>
      </li>)}</ul>
      <p className="op-muted">계획 배치 · 휴게는 아래 전체 배치표에 표시합니다. 대기 시뮬레이션은 휴게를 제외한 모의 결과입니다.</p>
    </div> : <p className="op-notice">인원·역할 요약이 없는 이전 결과입니다. 전체 배치표에서 계획을 확인해 주세요.</p>}
    {plan.staffing_summary?.total_staff_hours != null && <p className="op-muted">하루 총 배치시간 {numeric(plan.staffing_summary.total_staff_hours, '시간')} · 사장님 포함, 휴게 차감 전</p>}
    <p className="op-muted">{plan.closing == null ? '마감 판정 미제공' : `마감 실패 ${plan.closing.failed_repetitions}회 · 성공 비율 ${(plan.closing.success_ratio * 100).toFixed(1)}%`}</p>
    <h3 className="op-effect-label">예상 대기와 비용</h3>
    <span className="op-muted">주문 후 수령까지 평균</span><strong className="op-primary-metric">{minutes(plan.metrics.post_order_wait_mean_seconds)}</strong>
    <dl className="op-card-metrics"><div><dt>총 소요 p90</dt><dd>{minutes(plan.metrics.total_time_p90_seconds)}</dd></div>
      <div><dt>주문 후 300초 초과</dt><dd>{plan.metrics.post_order_wait_over_300_ratio == null ? '미확인' : `${(plan.metrics.post_order_wait_over_300_ratio * 100).toFixed(1)}%`}</dd></div>
      <div><dt>하루 직원 인건비</dt><dd>{numeric(plan.cash_cost_krw, '원')}</dd></div>
      <div><dt>현재 대비 추가 지출</dt><dd>{numeric(plan.additional_cash_cost_krw, '원')}</dd></div></dl>
    <p className="op-scope">{plan.cost_scope === 'BASE_WAGE_ONLY' ? '기본급 기준 · 주휴·보험 제외' : '선택한 비용 항목 기준'}</p>
    {comparison ? <div className="op-comparison"><strong>{inconclusive ? '차이 없음' : comparison.delta_vs_current_seconds < 0 ? '대기 감소' : '대기 증가'}</strong>
      <span>{metricLabels[comparison.metric] ?? comparison.metric} 차이 {numeric(comparison.delta_vs_current_seconds, '초')}</span>
      <span>95% 구간 {numeric(comparison.ci95_lower_seconds)} ~ {numeric(comparison.ci95_upper_seconds)}초</span>
      {inconclusive && <span>구간에 0이 포함됩니다. 두 안이 같다고 입증한 뜻은 아닙니다.</span>}
      <span>{comparison.paired_repetitions}회 중 {comparison.better_count}회 개선</span></div> : <div className="op-comparison"><strong>비교 기준</strong><span>현재 인원과 담당 업무</span></div>}
    <details><summary>지표 더 보기</summary><dl className="op-card-metrics">
      <div><dt>주문 줄 평균 대기</dt><dd>{minutes(plan.metrics.order_queue_wait_mean_seconds)}</dd></div>
      <div><dt>총 소요 평균</dt><dd>{minutes(plan.metrics.total_time_mean_seconds)}</dd></div>
      <div><dt>평균 완료 고객</dt><dd>{numeric(plan.metrics.completed_customer_count_mean, '명')}</dd></div>
      <div><dt>시간당 처리량</dt><dd>{numeric(plan.metrics.throughput_per_hour_mean, '명')}</dd></div>
      <div><dt>사장 노동시간</dt><dd>{plan.owner_work_seconds == null ? '미확인' : `${(plan.owner_work_seconds / 3600).toFixed(1)}시간`}</dd></div>
      <div><dt>월 추가 비용 추정</dt><dd>{numeric(plan.additional_monthly_cash_cost_estimate_krw, '원')}</dd></div></dl></details>
    <button className={selected ? '' : 'op-secondary'} aria-pressed={selected} onClick={onSelect}>{selected ? '선택한 안' : '이 안 선택'}</button>
  </article>
}
