import { useEffect, useState } from 'react'
import { loadOperationResult } from '../../../api/operationApi'
import { Alert, Icon } from '../../../components/common/Ui'
import type { OperationPlan } from '../../../types/api'
import type { JsonObject } from '../../../types/workflow'
import type { OperationResult, PlanSummary, Warning } from '../types'
import { CHOICE_KEYS, CHOICE_TITLE, CONFIRM_LABEL, minutes, won } from './format'
import OperationReport, { type Detail } from './OperationReport'
import './operationWorkspace.css'

/*
 * 업무 화면 02 · 운영 실험 결과 (요약 + 확정).
 * 좁은 결과 칸에는 세 안 요약과 확정만 둔다. 세 안 카드·배치표·시간대·재생·정리표 PDF는 넓은 화면(OperationReport)에서 본다.
 * 숫자는 Spring 결과(summary)만 쓰고 화면에서 다시 계산하지 않는다. 확정은 공통 확정 API로 한다(모의 조건 경고 확인 필수).
 */

const SIMULATED_ACK_TEXT = '실제 매장에서 잰 값이 아니라 가정한 조건으로 계산한 모의 결과라는 점을 확인했어요.'

export default function OperationComparison({
  result,
  input,
  savedChoice,
  valid,
  busy,
  onConfirm,
  onEdit,
}: {
  result: OperationResult
  input: JsonObject | null
  savedChoice: string | null
  valid: boolean
  busy: boolean
  onConfirm: (choice: string, warnings: string[]) => Promise<boolean>
  onEdit: () => void
}) {
  const summary = result.summary
  const plans = CHOICE_KEYS.map((k) => summary.choices?.find((p) => p.choice_key === k)).filter(
    (p): p is PlanSummary => Boolean(p),
  )
  const recommended = summary.recommendation?.choice_key ?? null
  const fastest = plans
    .filter((p) => Number.isFinite(p.metrics.post_order_wait_mean_seconds))
    .sort((a, b) => (a.metrics.post_order_wait_mean_seconds ?? 0) - (b.metrics.post_order_wait_mean_seconds ?? 0))[0]
    ?.choice_key
  // 추천이 없으면(세 안 모두 기준 미달) 5분 넘게 기다린 손님이 가장 적은 안, 같으면 더 빠른 안을 먼저 골라 둔다.
  const closest = [...plans].sort(
    (a, b) =>
      (a.metrics.post_order_wait_over_300_ratio ?? 1) - (b.metrics.post_order_wait_over_300_ratio ?? 1) ||
      (a.metrics.post_order_wait_mean_seconds ?? Infinity) - (b.metrics.post_order_wait_mean_seconds ?? Infinity),
  )[0]?.choice_key
  const [selected, setSelected] = useState<OperationPlan>(
    () => (savedChoice as OperationPlan | null) ?? recommended ?? closest ?? 'CURRENT',
  )
  const [acks, setAcks] = useState<string[]>([])
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [isReportOpen, setIsReportOpen] = useState(false)
  const [detailAttempt, setDetailAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    void loadOperationResult(result.result_id, 'detail', controller.signal).then((response) => {
      if (controller.signal.aborted) return
      if (response.status === 'ok' && response.data?.detail) setDetail(response.data.detail as unknown as Detail)
      else setDetailError(response.message ?? '배치표와 시간대 결과를 불러오지 못했어요.')
    })
    return () => controller.abort()
  }, [result.result_id, detailAttempt])
  const retryDetail = () => {
    setDetailError('')
    setDetailAttempt((n) => n + 1)
  }

  const warnings: Warning[] = summary.warnings ?? []
  const required = warnings.filter((w) => w.requires_ack)
  const notes = warnings.filter((w) => !w.requires_ack)
  const saved = savedChoice !== null
  const canSave = valid && !saved && !busy && required.every((w) => acks.includes(w.warning_id))

  if (!plans.length) return <Alert>운영 결과에 비교할 안이 없어요. 조건을 확인하고 다시 계산해 주세요.</Alert>
  return (
    <>
      <div className="result-intro">
        <strong className="opw-intro-title">같은 손님 조건으로 {summary.completed_repetitions ?? 30}번 돌린 결과예요</strong>
        <p>
          {summary.recommendation?.reason ??
            notes.find((w) => w.warning_id === 'NO_FEASIBLE_PLAN')?.message ??
            '세 안을 비교한 뒤 직접 선택해 주세요.'}
          {!recommended && closest && ` 기준에 가장 가까운 ${CHOICE_TITLE[closest]}을(를) 먼저 골라 뒀어요.`}
        </p>
        <p className="muted">가정한 처리시간과 손님 수로 돌린 모의 결과예요. 숫자보다 세 안의 차이를 보세요.</p>
      </div>
      <div className="opw-pad">
      <div className="opw-compact" role="radiogroup" aria-label="운영안 선택">
        {plans.map((p) => {
          const isSelected = p.choice_key === selected
          return (
            <button
              key={p.choice_key}
              type="button"
              role="radio"
              aria-checked={isSelected}
              className={`opw-compact-row ${isSelected ? 'selected' : ''}`}
              disabled={saved || busy}
              onClick={() => {
                setSelected(p.choice_key)
                setAcks([])
              }}
            >
              <span className="opw-compact-title">
                <b>{CHOICE_TITLE[p.choice_key]}</b>
                {p.choice_key === recommended && <em className="opw-tag rec">추천</em>}
                {p.choice_key === fastest && <em className="opw-tag">가장 빠름</em>}
              </span>
              <span className="opw-compact-num">
                <small>수령 평균</small>
                {minutes(p.metrics.post_order_wait_mean_seconds)}
              </span>
              <span className="opw-compact-num">
                <small>하루 인건비</small>
                {won(p.cash_cost_krw)}
              </span>
            </button>
          )
        })}
      </div>
      <button type="button" className="button secondary opw-open-report" onClick={() => setIsReportOpen(true)}>
        세 안 자세히 보기 (배치표 · 대기열 재생 · 정리표 PDF)
      </button>
      {!valid && !saved && <Alert error>조건이 바뀌었어요. 입력을 다시 확인한 뒤 계산해 주세요.</Alert>}
      {detailError && <Alert error>{detailError}</Alert>}
      <div className="warning-list">
        {required.map((w) => (
          <label className="warning required opw-ack" key={w.warning_id}>
            <input
              type="checkbox"
              checked={saved || acks.includes(w.warning_id)}
              disabled={busy || saved}
              onChange={(e) =>
                setAcks((previous) =>
                  e.target.checked ? [...previous, w.warning_id] : previous.filter((id) => id !== w.warning_id),
                )
              }
            />
            <span>
              <b>확인 필요</b>
              {w.warning_id === 'SIMULATED_CONDITIONS' ? SIMULATED_ACK_TEXT : w.message}
            </span>
          </label>
        ))}
        {notes
          .filter((w) => w.warning_id !== 'NO_FEASIBLE_PLAN')
          .map((w) => (
            <div className="warning" key={w.warning_id}>
              <span aria-hidden="true">ⓘ</span>
              <span>
                <b>참고</b>
                {w.message}
              </span>
            </div>
          ))}
      </div>
      </div>
      <div className="result-footer">
        <button className="button secondary" disabled={busy} onClick={onEdit}>
          조건 수정
        </button>
        <button
          className="button primary"
          disabled={!canSave}
          onClick={() =>
            {
              const startedAt = window.location.hash
              void onConfirm(selected, required.map((w) => w.warning_id)).then((ok) => {
                // 확정이 끝나면 저장한 계획 목록으로 옮긴다. 기다리는 동안 다른 화면으로 갔으면 그대로 둔다.
                if (ok && window.location.hash === startedAt) window.location.hash = '/confirmations'
              })
            }
          }
        >
          {busy ? '처리 중…' : saved ? '확정·저장 완료' : CONFIRM_LABEL[selected]}
          <Icon name="check" size={16} />
        </button>
        <p>계획을 저장하면 저장한 계획 화면으로 이동해요. 근무표 앱 반영이나 채용은 하지 않아요.</p>
      </div>
      {isReportOpen && (
        <OperationReport
          result={result}
          detail={detail}
          detailError={detailError}
          onRetryDetail={retryDetail}
          input={input}
          selected={selected}
          recommended={recommended}
          fastest={fastest}
          confirmed={saved}
          locked={saved || busy}
          onSelect={(choice) => {
            setSelected(choice)
            setAcks([])
          }}
          onClose={() => setIsReportOpen(false)}
        />
      )}
    </>
  )
}
