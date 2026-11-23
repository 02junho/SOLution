// 쉬운 화면의 결과·확인 조각: 카드, 고르기, 저장, 매입 결과, 운영 결과(배치표·비교·줄 서는 모습).
// 새로 계산한 결과, 이어서 연 업무, 저장한 계획 보기가 모두 이 조각을 같이 쓴다.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { confirmOperation, loadOperationTrace } from '../../api/operationApi'
import { workflowApi, WorkflowError } from '../../api/workflowApi'
import { simulationClock, stateAt } from '../operation/replay'
import type { OperationResult, OperationTrace, PlanSummary, Shift } from '../operation/types'
import { TASK_LABEL, WORKER_LABEL, won } from '../operation/workspace/format'
import type { OperationPlan } from '../../types/api'
import type { PurchaseResult } from '../../types/workflow'
import { changedSegments, perHundred, segmentKey } from './route'
import { amount, compareItems, compareSentence, deliveriesOf, violationLabels } from './purchaseCompare'
import type { Baseline, BuyNeed, CompareLine } from './purchaseCompare'
import { forgetSaves, saveKey } from './saveKey'

export type Prepared = { sessionId: number; versionId: number; versionNo: number }
type SupplierTotal = { supplier_id: string; supplier_name: string; goods_krw: number; delivery_fee_krw: number }
type PurchaseChoice = {
  choice_key: string; label?: string; available?: boolean; same_as?: string | null
  total_krw?: number; delivery_count?: number; supplier_totals?: SupplierTotal[]; warning_ids?: string[]
}
type PurchaseLine = { supplier_id: string; supplier_name: string; item_name: string; pack_size: number; pack_unit: string; pack_count: number; line_krw: number }
type PurchaseDetailChoice = { choice_key: string; lines?: PurchaseLine[]; order_messages?: { supplier_id: string; text: string }[] }

const PLAN_TITLE: Record<OperationPlan, string> = { CURRENT: '지금 그대로', ALT_A: '바쁠 때 서로 돕기', ALT_C: '점심에 한 명 더' }
const PLAN_HEADLINE: Record<OperationPlan, string> = {
  CURRENT: '지금 인원 그대로 해도 괜찮아요',
  ALT_A: '점심(11~14시)에 서로 도우면 돼요',
  ALT_C: '점심(11~14시)에 한 명 더 쓰면 좋아요',
}
const CHOICE_NAME: Record<string, string> = { purchase_1: '가장 싸게', purchase_2: '한 곳에서 한 번에' }
const unitLabel = (size: number, unit: string) =>
  unit === 'g' && size >= 1000 ? `${size / 1000}kg` : unit === 'ml' && size >= 1000 ? `${size / 1000}L` : unit === 'ea' ? `${size}개` : `${size}${unit}`
// 배치표 칸은 좁아서 짧은 이름을 쓴다. 서로 돕는 시간은 "+도움"으로.
const SHORT_TASK: Record<string, string> = {
  ORDER_HANDOFF: '주문·전달', PREPARATION: '음료 제조',
  ORDER_HANDOFF_HELP_PREPARATION: '주문 +제조 도움', PREPARATION_HELP_ORDER_HANDOFF: '제조 +주문 도움',
  ALL_TASKS: '모든 일', ORDER: '주문', MAKE: '제조', FLEX: '모든 일',
}
const hourOf = (hhmm: string) => Number(hhmm.slice(0, 2)) + Number(hhmm.slice(3, 5)) / 60
const printedOn = () => { const d = new Date(); return `${d.getMonth() + 1}월 ${d.getDate()}일` }
const workerName = (key: string) => WORKER_LABEL[key] ?? key.replace('STAFF_', '직원 ')

/** 문구 복사. 보안 연결(https·localhost)이면 클립보드 기능을, 아니면(http 배포) 옛 복사 방법을 쓴다. 실제로 복사됐는지 돌려준다. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch { /* 아래 옛 방법으로 한 번 더 */ }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  } catch {
    return false
  }
}

export function Card({ title, children, tour }: { title: string; children: ReactNode; tour?: string }) {
  return <section className="easy-card" data-tour={tour}><h2>{title}</h2>{children}</section>
}

export function Pick({ label, value, options, format, onPick }: { label: string; value: number; options: number[]; format: (v: number) => string; onPick: (v: number) => void }) {
  return (
    <fieldset className="easy-pick">
      <legend>{label}</legend>
      {options.map((option) => (
        <button key={option} type="button" aria-pressed={option === value} className={option === value ? 'on' : ''} onClick={() => onPick(option)}>
          {format(option)}
        </button>
      ))}
    </fieldset>
  )
}

export function SaveBox({ lines, warnings, onSave, saved }: { lines: string[]; warnings: { warning_id: string; message: string }[]; onSave: (acks: string[]) => Promise<void>; saved: string }) {
  const [open, setOpen] = useState(false)
  const [acks, setAcks] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (saved) return <p className="easy-done">{saved}</p>
  if (!open) return <button type="button" className="easy-primary" onClick={() => setOpen(true)}>저장하기</button>
  const ready = warnings.every((w) => acks.includes(w.warning_id))
  return (
    <div className="easy-save">
      <h3>이대로 저장할까요?</h3>
      <ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul>
      {warnings.map((w) => (
        <label key={w.warning_id} className="easy-check">
          <input type="checkbox" checked={acks.includes(w.warning_id)} onChange={(e) => setAcks(e.target.checked ? [...acks, w.warning_id] : acks.filter((id) => id !== w.warning_id))} />
          {w.message}
        </label>
      ))}
      {error && <p className="easy-error">{error}</p>}
      <div className="easy-actions">
        <button type="button" className="easy-primary" disabled={!ready || busy} onClick={async () => {
          setBusy(true); setError('')
          try { await onSave(acks) } catch (cause) { setError(cause instanceof Error ? cause.message : '저장하지 못했어요. 다시 눌러 주세요.') } finally { setBusy(false) }
        }}>{busy ? '저장하는 중…' : '저장하기'}</button>
        <button type="button" className="easy-secondary" onClick={() => setOpen(false)}>취소하기</button>
      </div>
    </div>
  )
}

export function PurchaseView({ result, prepared, saved, savedFor = null, onSaved, savedChoice = null, maxDeliveries = null }: { result: PurchaseResult; prepared: Prepared; saved: string; savedFor?: string | null; onSaved: (text: string, choiceKey: string) => void; savedChoice?: string | null; maxDeliveries?: number | null }) {
  const [showOrder, setShowOrder] = useState(false)
  const [showLines, setShowLines] = useState(false)
  // 복사 결과: 어느 거래처 문구를, 실제로 복사됐는지(http에서는 클립보드 기능이 없을 수 있다)
  const [copied, setCopied] = useState<{ id: string; ok: boolean } | null>(null)
  // 사장님이 고른 안(없으면 추천). 추천이 아닌 안도 골라 보고 저장할 수 있다.
  const [pick, setPick] = useState<string | null>(null)
  const choices = (result.summary.choices ?? []) as PurchaseChoice[]
  const details = ((result.detail as { choices?: PurchaseDetailChoice[] } | null)?.choices ?? [])
  // 저장한 계획을 볼 때는 저장한 안을, 아니면 추천(가장 싼 안)을 맨 위에 둔다.
  const recommended = choices.find((c) => c.available && c.choice_key === 'purchase_1') ?? choices.find((c) => c.available)
  const selectable = choices.filter((c) => c.available && !c.same_as)
  const best = (savedChoice ? choices.find((c) => c.choice_key === savedChoice) : null)
    ?? (pick ? selectable.find((c) => c.choice_key === pick) : null) ?? recommended
  const other = choices.find((c) => c.available && c !== best && !c.same_as)
  const isRecommended = best?.choice_key === recommended?.choice_key
  const bestDetail = details.find((d) => d.choice_key === best?.choice_key)
  const warnings = (result.summary.warnings ?? []) as unknown as { warning_id: string; message: string }[]
  if (!best) return <Card title="살 수 있는 조합이 없어요"><p>{result.summary.message ?? '조건을 고쳐서 다시 해 보세요.'}</p></Card>
  const names = (best.supplier_totals ?? []).map((s) => s.supplier_name)
  return (
    <>
      <section className="easy-verdict" data-tour="verdict">
        <p className="easy-label">{savedChoice ? '저장한 계획' : isRecommended ? '추천' : '고른 안'}</p>
        <h2>이렇게 사면 <em>{won(best.total_krw)}</em>이에요</h2>
        <p>거래처 {names.length}곳 · 배송 {best.delivery_count}번: {names.join(', ')}</p>
        {!savedChoice && selectable.length > 1 && (
          <div className="easy-pick easy-choose" role="group" aria-label="어느 안으로 볼까요">
            {selectable.map((c) => (
              <button key={c.choice_key} type="button" aria-pressed={c.choice_key === best.choice_key} className={c.choice_key === best.choice_key ? 'on' : ''}
                onClick={() => { setPick(c.choice_key); setShowOrder(false); setShowLines(false) }}>
                {CHOICE_NAME[c.choice_key] ?? c.label} · {won(c.total_krw)}{c.choice_key === recommended?.choice_key ? ' (추천)' : ''}
              </button>
            ))}
          </div>
        )}
        <div className="easy-actions" data-tour="detail">
          <button type="button" className="easy-secondary" onClick={() => setShowOrder(!showOrder)} aria-expanded={showOrder}>{showOrder ? '주문 문구 접기' : '주문 문구 보기'}</button>
          <button type="button" className="easy-secondary" onClick={() => setShowLines(!showLines)} aria-expanded={showLines}>{showLines ? '살 것 접기' : '무엇을 몇 개 사나요?'}</button>
        </div>
      </section>

      {showOrder && (
        <section className="easy-card">
          <h2>거래처에 보낼 주문 문구</h2>
          {(bestDetail?.order_messages ?? []).map((message) => {
            const name = best.supplier_totals?.find((s) => s.supplier_id === message.supplier_id)?.supplier_name ?? message.supplier_id
            return (
              <div key={message.supplier_id} className="easy-message">
                <h3>{name}</h3>
                <pre>{message.text}</pre>
                <button type="button" className="easy-secondary" onClick={async () => setCopied({ id: message.supplier_id, ok: await copyText(message.text) })}>
                  {copied?.id === message.supplier_id && copied.ok ? '복사했어요' : '문구 복사하기'}
                </button>
                {copied?.id === message.supplier_id && !copied.ok && (
                  <p className="easy-note" role="status">복사가 안 됐어요. 위 문구를 길게 눌러(또는 끌어서) 직접 복사해 주세요.</p>
                )}
              </div>
            )
          })}
        </section>
      )}

      {showLines && (
        <section className="easy-card">
          <h2>살 것</h2>
          <ul className="easy-facts">
            {(bestDetail?.lines ?? []).map((line, i) => (
              <li key={i}><span>{line.supplier_name}</span><b>{line.item_name} {unitLabel(line.pack_size, line.pack_unit)} × {line.pack_count}개 · {won(line.line_krw)}</b></li>
            ))}
          </ul>
        </section>
      )}

      <WhyCard result={result} best={best} other={other ?? null} saved={Boolean(savedChoice)} picked={!isRecommended} maxDeliveries={maxDeliveries} />

      {savedChoice ? <p className="easy-done">{saved || '저장한 계획이에요'}</p> : (
      <section className="easy-card" data-tour="save">
        <SaveBox
          key={best.choice_key}
          saved={savedFor === best.choice_key ? saved : ''}
          warnings={warnings.filter((w) => (best.warning_ids ?? []).includes(w.warning_id))}
          lines={[`${CHOICE_NAME[best.choice_key] ?? best.label ?? ''} · ${won(best.total_krw)} · 거래처 ${names.length}곳 · 배송 ${best.delivery_count}번`]}
          onSave={async (acks) => {
            // 다시 눌러도 같은 키: 연결이 끊겨 응답을 못 받았어도 서버에는 한 번만 저장된다.
            try {
              await workflowApi.confirm(result.result_id, prepared.versionId, best.choice_key, acks, saveKey(result.result_id, prepared.versionId, best.choice_key, acks))
            } catch (cause) {
              if (cause instanceof WorkflowError && cause.code === 'CONFIRMATION_DELETED') forgetSaves(result.result_id)
              throw cause
            }
            onSaved('저장했어요', best.choice_key)
          }}
        />
      </section>
      )}
    </>
  )
}

/** 왜 이 안이에요? 단가만 보고 고른 안 · 다른 안 · 이 안을 막대로 비교하고, 품목별 차이는 접어 둔다. */
function WhyCard({ result, best, other, saved, picked, maxDeliveries }: { result: PurchaseResult; best: PurchaseChoice; other: PurchaseChoice | null; saved: boolean; picked: boolean; maxDeliveries: number | null }) {
  const detail = result.detail as { baseline?: Baseline; buy_needs?: BuyNeed[]; choices?: { choice_key: string; lines?: CompareLine[] }[] } | null
  const baseline = detail?.baseline
  const chosenLines = detail?.choices?.find((c) => c.choice_key === best.choice_key)?.lines ?? []
  if (!baseline?.lines?.length || !chosenLines.length || typeof best.total_krw !== 'number') return null
  const rows = compareItems(baseline.lines, chosenLines, detail?.buy_needs ?? [])
  const baseDeliveries = deliveriesOf(baseline.lines)
  const broken = violationLabels(baseline.constraint_violations ?? [], baseDeliveries, maxDeliveries)
  const sentence = compareSentence(rows, { deliveries: best.delivery_count ?? null, total: best.total_krw }, { deliveries: baseDeliveries, total: baseline.total_krw ?? null })
  const bars = [
    { key: 'baseline', label: '단가만 보고 고르면', krw: baseline.total_krw, tags: broken.length ? broken : [`배송 ${baseDeliveries}번`], tone: 'bad' },
    ...(other && typeof other.total_krw === 'number'
      ? [{ key: other.choice_key, label: CHOICE_NAME[other.choice_key] ?? other.label ?? '다른 안', krw: other.total_krw, tags: [`배송 ${other.delivery_count}번`, '조건 모두 지킴'], tone: 'plain' }]
      : []),
    { key: best.choice_key, label: `${saved ? '저장한 안' : picked ? '고른 안' : '추천'} · ${CHOICE_NAME[best.choice_key] ?? best.label ?? ''}`, krw: best.total_krw, tags: [`배송 ${best.delivery_count}번`, '조건 모두 지킴'], tone: 'best' },
  ]
  const top = Math.max(...bars.map((b) => b.krw))
  return (
    <section className="easy-card easy-why" data-tour="why">
      <h2>{picked ? '이 안은 어때요?' : '왜 이 안이에요?'}</h2>
      {sentence && <p className="easy-why-lead">{sentence}</p>}
      <ul className="easy-why-bars">
        {bars.map((bar) => (
          <li key={bar.key} className={`tone-${bar.tone}`}>
            <div className="easy-why-head"><span>{bar.label}</span><b>{won(bar.krw)}</b></div>
            <div className="easy-why-track"><div style={{ width: `${Math.max(8, (bar.krw / top) * 100)}%` }} /></div>
            <p className="easy-why-tags">{bar.tags.map((t) => <span key={t}>{t}</span>)}</p>
          </li>
        ))}
      </ul>
      <details className="easy-why-items">
        <summary>품목별로 보기</summary>
        <ul>
          {rows.map((row) => (
            <li key={row.key}>
              <p className="easy-why-item"><b>{row.item}</b>{row.need > 0 && <small>필요한 양 {amount(row.need, row.unit)}</small>}</p>
              <div className="easy-why-pair">
                <span>단가만 보면</span>
                <p>{row.baseline ? `${row.baseline.packs} · ${won(row.baseline.krw)}` : '사지 않아요'}{row.overbuy && <em> 너무 많아요</em>}</p>
              </div>
              <div className="easy-why-pair best">
                <span>{saved ? '저장한 안' : picked ? '고른 안' : '추천'}</span>
                <p>{row.chosen ? `${row.chosen.packs} · ${won(row.chosen.krw)}` : '사지 않아요'}</p>
              </div>
              {row.pricierNote && <p className="easy-why-note">{row.pricierNote}</p>}
            </li>
          ))}
        </ul>
      </details>
      <p className="easy-why-foot">단가만 보고 고른 안은 거래처 조건을 보지 않아서 실제로는 주문이 안 될 수 있어요.</p>
    </section>
  )
}

export function OperationView({ result, saved, savedFor = null, onSaved, savedChoice = null }: { result: OperationResult; prepared: Prepared; saved: string; savedFor?: string | null; onSaved: (text: string, choiceKey: string) => void; savedChoice?: OperationPlan | null }) {
  const summary = result.summary
  const choices = summary.choices ?? []
  const [pick, setPick] = useState<OperationPlan | null>(null)
  const advised = summary.recommendation?.choice_key ?? null
  // 저장한 계획을 볼 때는 저장한 안을, 사장님이 고른 방법이 있으면 그 방법을, 아니면 추천 안을 맨 위에 둔다.
  const recommended = savedChoice ?? pick ?? advised
  const isAdvised = recommended === advised
  const plan = choices.find((c) => c.choice_key === recommended) ?? null
  const current = choices.find((c) => c.choice_key === 'CURRENT') ?? null
  const plans = result.detail?.schedule.plans ?? []
  const schedule = plans.find((p) => p.choice_key === (recommended ?? 'CURRENT'))?.schedule ?? []
  const currentSchedule = plans.find((p) => p.choice_key === 'CURRENT')?.schedule ?? []
  const warnings = (summary.warnings ?? []).filter((w) => w.requires_ack)
  const shown = plan ?? current

  return (
    <>
      <section className="easy-verdict" data-tour="verdict">
        <p className="easy-label">{savedChoice ? '저장한 계획' : !recommended ? '결과' : isAdvised ? '추천' : '고른 방법'}</p>
        <h2>{!recommended ? '세 방법 모두 목표를 지키기 어려워요' : isAdvised ? PLAN_HEADLINE[recommended] : `"${PLAN_TITLE[recommended]}"로 하면 이래요`}</h2>
        {shown && (
          <p>
            5분 넘게 기다린 손님: <b>{perHundred(shown.metrics.post_order_wait_over_300_ratio)}</b> ·
            하루 인건비 <b>{won(shown.cash_cost_krw)}</b>
            {typeof shown.additional_cash_cost_krw === 'number' && (shown.additional_cash_cost_krw > 0 ? ` (지금보다 ${won(shown.additional_cash_cost_krw)} 더)` : ' (지금과 같아요)')}
          </p>
        )}
        {!savedChoice && choices.length > 1 && (
          <div className="easy-pick easy-choose" role="group" aria-label="어느 방법으로 볼까요">
            {choices.map((c) => (
              <button key={c.choice_key} type="button" aria-pressed={c.choice_key === recommended} className={c.choice_key === recommended ? 'on' : ''} onClick={() => setPick(c.choice_key)}>
                {PLAN_TITLE[c.choice_key]}{c.choice_key === advised ? ' (추천)' : ''}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="easy-card easy-print" data-tour="detail">
        <h2>{recommended ? `${savedChoice ? '저장한' : isAdvised ? '추천' : '고른'} 배치표 · ${PLAN_TITLE[recommended]}` : '지금 배치표'}</h2>
        <p className="easy-print-only easy-print-meta">영업 오전 7시 ~ 오후 7시 · 뽑은 날 {printedOn()}</p>
        <ScheduleGrid schedule={schedule} current={currentSchedule} />
        <p className="easy-print-only easy-print-legend">
          <span><i style={{ background: '#e8f3ff' }} />주문·전달</span>
          <span><i style={{ background: '#e5f6ec' }} />음료 제조</span>
          <span><i style={{ background: '#fff5e6' }} />손님이 몰리는 시간</span>
          <span><i style={{ border: '2px solid #1f54d6' }} />지금과 바뀐 곳</span>
          <span><i style={{ background: 'repeating-linear-gradient(45deg,#656870,#656870 3px,transparent 3px,transparent 6px)' }} />휴게</span>
        </p>
        <p className="easy-print-only easy-print-sign">확인 ____________</p>
        <p className="easy-total easy-noprint">
          총 근무 {shown?.staffing_summary?.total_staff_hours ?? shown?.staffing?.total_staff_hours ?? '—'}시간 · 예상 인건비 {won(shown?.cash_cost_krw)}
        </p>
        <div className="easy-actions easy-noprint">
          <button type="button" className="easy-secondary" onClick={() => window.print()}>배치표 인쇄</button>
        </div>
      </section>

      <details className="easy-card easy-fold">
        <summary>세 방법 비교</summary>
        <div className="easy-plans">
          {choices.map((choice: PlanSummary) => (
            <div key={choice.choice_key} className={`easy-plan${choice.choice_key === recommended ? ' best' : ''}`}>
              {(choice.choice_key === (savedChoice ?? advised)) && <span className="easy-badge">{savedChoice ? '저장함' : '추천'}</span>}
              <h3>{PLAN_TITLE[choice.choice_key]}</h3>
              <p>5분 넘게 기다린 손님<br /><b>{perHundred(choice.metrics.post_order_wait_over_300_ratio)}</b></p>
              <p>하루 인건비<br /><b>{won(choice.cash_cost_krw)}</b>{typeof choice.additional_cash_cost_krw === 'number' && choice.additional_cash_cost_krw > 0 ? ` (+${won(choice.additional_cash_cost_krw)})` : ''}</p>
            </div>
          ))}
        </div>
      </details>

      {/* 줄 서는 모습은 운영 결과의 핵심이라 처음부터 펼쳐 둔다(제목을 누르면 접을 수 있음) */}
      <details className="easy-card easy-fold" open>
        <summary>줄 서는 모습</summary>
        <EasyReplay result={result} first={recommended ?? 'CURRENT'} />
      </details>

      {recommended && (savedChoice ? <p className="easy-done">{saved || '저장한 계획이에요'}</p> : (
        <section className="easy-card" data-tour="save">
          <SaveBox
            key={recommended}
            saved={savedFor === recommended ? saved : ''}
            warnings={warnings}
            lines={[`${PLAN_TITLE[recommended]} · 하루 인건비 ${won(plan?.cash_cost_krw)}`]}
            onSave={async (acks) => {
              const response = await confirmOperation(result, recommended, acks, saveKey(result.result_id, result.input_version_id, recommended, acks))
              if (response.status === 'error') {
                if ((response.data as { detail_code?: string } | null)?.detail_code === 'CONFIRMATION_DELETED') forgetSaves(result.result_id)
                throw new Error(response.message || '저장하지 못했어요.')
              }
              onSaved('저장했어요', recommended)
            }}
          />
        </section>
      ))}
    </>
  )
}

export function ScheduleGrid({ schedule, current }: { schedule: Shift[]; current: Shift[] }) {
  const workers = [...new Set(schedule.map((s) => s.worker_key))]
  const changed = changedSegments(current, schedule)
  const newWorkers = new Set(workers.filter((w) => !current.some((s) => s.worker_key === w)))
  const hours = Array.from({ length: 13 }, (_, i) => 7 + i)
  const left = (h: number) => `${((h - 7) / 12) * 100}%`
  const width = (a: number, b: number) => `${((b - a) / 12) * 100}%`
  return (
    <div className="easy-grid" role="table" aria-label="사람별 시간대 배치표">
      <div className="easy-grid-row easy-grid-head" role="row">
        <span role="columnheader">사람</span>
        <div className="easy-grid-track">{hours.map((h) => <i key={h} style={{ left: left(h) }}>{h}시</i>)}</div>
      </div>
      {workers.map((worker) => (
        <div key={worker} className="easy-grid-row" role="row">
          <span role="rowheader">{workerName(worker)}{newWorkers.has(worker) && <em className="easy-new">추가</em>}</span>
          <div className="easy-grid-track">
            <div className="easy-grid-busy" style={{ left: left(11), width: width(11, 14) }} title="손님이 몰리는 시간" />
            {schedule.filter((s) => s.worker_key === worker).map((s) => {
              const a = hourOf(s.start_time), b = hourOf(s.end_time)
              const isChanged = changed.has(segmentKey(s))
              // 휴게는 칸 글자를 가리지 않게 칸 안 글자로 적고, 칸 아래쪽 얇은 줄로만 표시한다.
              const rest = s.breaks.map((r) => ` · 휴게 ${r.start_time.slice(0, 2)}~${r.end_time.slice(0, 2)}시`).join('')
              return (
                <div key={segmentKey(s)} className={`easy-bar task-${s.task_code}${isChanged ? ' changed' : ''}`} style={{ left: left(a), width: width(a, b) }}>
                  <span>{SHORT_TASK[s.task_code] ?? TASK_LABEL[s.task_code] ?? s.task_code}</span>
                  <small>{s.start_time.slice(0, 2)}~{s.end_time.slice(0, 2)}시{isChanged ? ' · 바뀜' : ''}{rest}</small>
                </div>
              )
            })}
            {schedule.filter((s) => s.worker_key === worker).flatMap((s) => s.breaks).map((b) => (
              <div key={`${worker}-${b.start_time}`} className="easy-break" title={`휴게 ${b.start_time}~${b.end_time}`}
                style={{ left: left(hourOf(b.start_time)), width: width(hourOf(b.start_time), hourOf(b.end_time)) }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/** 줄 서는 모습: 기존 대기열 재생(QueueReplay)을 쉬운 화면 안에서. 세 방법을 골라 볼 수 있다. */
function EasyReplay({ result, first }: { result: OperationResult; first: OperationPlan }) {
  const [choice, setChoice] = useState<OperationPlan>(first)
  const [loaded, setLoaded] = useState<{ logId: number; trace: OperationTrace | null; error: string } | null>(null)
  const refs = result.detail?.trace_refs ?? []
  const ref = refs.filter((r) => r.choice_key === choice).sort((a, b) => a.replication_no - b.replication_no)[0]
  const logId = ref?.log_id
  useEffect(() => {
    if (logId === undefined) return
    let alive = true
    void loadOperationTrace(result.result_id, logId).then((response) => {
      if (!alive) return
      setLoaded({ logId, trace: response.status === 'error' ? null : response.data, error: response.status === 'error' ? (response.message ?? '불러오지 못했어요') : '' })
    })
    return () => { alive = false }
  }, [result.result_id, logId])
  const keys = (result.summary.choices ?? []).map((c) => c.choice_key)
  return (
    <div className="easy-replay">
      <div className="easy-pick" role="group" aria-label="어느 방법을 볼까요">
        {keys.map((key) => (
          <button key={key} type="button" aria-pressed={key === choice} className={key === choice ? 'on' : ''} onClick={() => setChoice(key)}>{PLAN_TITLE[key]}</button>
        ))}
      </div>
      {logId === undefined ? <p className="easy-empty">이 방법은 기록이 없어요</p>
        : !loaded || loaded.logId !== logId ? <p className="easy-empty">불러오는 중이에요</p>
          : loaded.trace ? <EasyQueue key={logId} trace={loaded.trace} />
            : <p className="easy-error">{loaded.error}</p>}
    </div>
  )
}

// 쉬운 화면용 줄 재생. 원래 업무 화면의 QueueReplay와 같은 기록(trace)·계산(stateAt)을 쓰고, 보여 주는 말과 버튼만 바꾼다.
// 점심(11시)부터 시작하고, 개발 용어(반복·투입·OWNER) 대신 사장님 말로, 버튼은 크게.
const QUEUE_BOXES: { title: string; stages: string[] }[] = [
  { title: '주문 줄', stages: ['ORDER_QUEUE'] },
  { title: '주문하는 중', stages: ['ORDERING'] },
  { title: '음료 기다리는 중', stages: ['WAITING_PREPARATION'] },
  { title: '만들고 건네는 중', stages: ['PREPARING', 'WAITING_HANDOFF'] },
]
const JUMPS = [{ label: '아침 7시', hour: 7 }, { label: '점심 11시', hour: 11 }, { label: '오후 2시', hour: 14 }]

function clockLabel(hhmmss: string) {
  const [h, m] = hhmmss.split(':').map(Number)
  return `${h < 12 ? '오전' : '오후'} ${h % 12 === 0 ? 12 : h % 12}시 ${String(m).padStart(2, '0')}분`
}

function EasyQueue({ trace }: { trace: OperationTrace }) {
  const [oh, om, os = 0] = trace.time_origin.split(':').map(Number)
  const origin = oh * 3600 + om * 60 + os
  const duration = trace.events.reduce((last, e) => Math.max(last, e.at_seconds), trace.observation_window?.end_seconds ?? 0)
  const at = (hour: number) => Math.min(duration, Math.max(0, hour * 3600 - origin))
  const [time, setTime] = useState(() => at(11))
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const start = performance.now()
    const initial = time
    const tick = (now: number) => {
      const next = Math.min(duration, initial + ((now - start) / 1000) * 60) // 1초에 1분
      setTime(next)
      if (next >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // 재생을 시작할 때의 시각에서 이어 간다(프레임마다 다시 시작하지 않게).
  }, [playing, duration]) // eslint-disable-line react-hooks/exhaustive-deps
  const state = stateAt(trace, time)
  const counts = QUEUE_BOXES.map((box) => [...state.customers.values()].filter((stage) => box.stages.includes(stage)).length)
  const waiting = counts[0] + counts[2]
  const staff = [...state.activeStaff].map(workerName)
  return (
    <div className="easy-queue">
      {!state.initialKnown && <p className="easy-note">예전 기록이라 일부 손님만 보여요.</p>}
      <div className="easy-queue-head">
        <b className="easy-queue-clock">{clockLabel(simulationClock(trace.time_origin, time))}</b>
        <span>기다리는 손님 <b>{waiting}명</b> · 받아 간 손님 {state.completed}명</span>
        {staff.length > 0 && <span>일하는 사람: {staff.join(' · ')}</span>}
      </div>
      <div className="easy-queue-boxes">
        {QUEUE_BOXES.map((box, i) => (
          <div key={box.title} className="easy-queue-box">
            <p><span>{box.title}</span><b>{counts[i]}명</b></p>
            <div className="easy-queue-dots" aria-hidden>
              {Array.from({ length: Math.min(counts[i], 12) }, (_, j) => <i key={j} />)}
              {counts[i] > 12 && <em>+{counts[i] - 12}</em>}
            </div>
          </div>
        ))}
      </div>
      <input className="easy-queue-scrub" aria-label="보는 시각" type="range" min="0" max={duration} step="60" value={time}
        onChange={(e) => { setPlaying(false); setTime(Number(e.target.value)) }} />
      <div className="easy-queue-controls">
        <button type="button" className="easy-primary" onClick={() => { if (time >= duration) setTime(at(11)); setPlaying(!playing) }}>
          {playing ? '■ 멈추기' : '▶ 재생'}
        </button>
        {JUMPS.map((jump) => (
          <button key={jump.hour} type="button" className="easy-secondary" onClick={() => { setPlaying(false); setTime(at(jump.hour)) }}>{jump.label}</button>
        ))}
      </div>
      <p className="easy-queue-hint">1초에 1분씩 흘러가요. 아래 막대를 끌어서 원하는 시각을 볼 수도 있어요.</p>
    </div>
  )
}
