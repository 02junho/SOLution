import DeleteConfirmation from './DeleteConfirmation'
import { useEffect, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import { Alert, Icon, Modal } from '../../components/common/Ui'
import type { FeatureType } from '../../types/api'
import type { ConfirmationDetail, JsonObject } from '../../types/workflow'
import {
  amount,
  applicableWarnings,
  dateTime,
  currentQuestion,
  featureName,
  object,
  resolveChoice,
} from './model'
import type { WorkspaceController } from './useWorkspace'
import ResultExplanation from './ResultExplanation'
// 운영 결과 비교·확정 요약 화면 연결
import OperationComparison from '../operation/workspace/OperationComparison'
import OperationConfirmationSummary from '../operation/workspace/OperationConfirmationSummary'
import { CHOICE_TITLE } from '../operation/workspace/format'

function nameOf(
  input: JsonObject | null,
  section: 'items' | 'suppliers',
  id: unknown,
) {
  const data = input?.[section]
  const entry = Array.isArray(data)
    ? data
        .map(object)
        .find(
          (item) =>
            item[section === 'items' ? 'item_id' : 'supplier_id'] === id,
        )
    : undefined
  return String(
    entry?.[section === 'items' ? 'item_name' : 'supplier_name'] ??
      (typeof id === 'string' ? id : section === 'items' ? '품목' : '거래처'),
  )
}
export function PurchaseLines({
  lines,
  input,
}: {
  lines: JsonObject[]
  input: JsonObject | null
}) {
  if (!lines.length) return <p className="muted">저장된 구매 목록이 없어요.</p>
  return (
    <div className="table-scroll">
      <table className="data-table">
        <thead>
          <tr>
            <th>거래처 / 품목</th>
            <th>묶음 수</th>
            <th>금액</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td>
                <strong>
                  {String(
                    line.item_name ?? nameOf(input, 'items', line.item_id),
                  )}
                </strong>
                <small>
                  {String(
                    line.supplier_name ??
                      nameOf(input, 'suppliers', line.supplier_id),
                  )}{' '}
                  · {amount(line.pack_size, String(line.pack_unit ?? ''))}
                </small>
              </td>
              <td>{amount(line.pack_count, '개')}</td>
              <td>{amount(line.line_krw)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
export default function Results({
  feature,
  workspace,
  onEdit,
  onSaved,
}: {
  feature: FeatureType
  workspace: WorkspaceController
  onEdit: () => void
  onSaved: (id: number) => void
}) {
  const { context, input, busy } = workspace
  const type = context?.feature_type ?? feature
  const pending = currentQuestion(workspace.messages, context)
  const result = pending ? null : workspace.result
  // 운영 결과(구매 결과와 모양이 달라 따로 받는다)
  const operation = pending || type !== 'operation' ? null : workspace.operation
  const saved = pending ? null : workspace.saved
  const [selected, setSelected] = useState(
    () => saved?.selected_choice_key ?? '',
  )
  const [acks, setAcks] = useState<string[]>([])
  const [copyNotice, setCopyNotice] = useState('')
  const choices = result?.summary.choices ?? []
  const choiceLabels = Object.fromEntries(
    choices.map((item, index) => [
      item.choice_key,
      item.label ?? `대안 ${index + 1}`,
    ]),
  )
  const choice = choices.find((item) => item.choice_key === selected)
  const resolved = choice ? resolveChoice(choice, choices) : null
  const warnings = applicableWarnings(
    choice,
    choices,
    result?.summary.warnings ?? [],
  )
  const detail = result?.detail?.choices?.find(
    (item) => item.choice_key === resolved?.choice_key,
  )
  const validResult =
    context &&
    context.input_confirmed &&
    result?.is_latest_version &&
    result.response_status === 'ok' &&
    result.input_version_id === context.current_version_id
  const canSave =
    validResult &&
    !saved &&
    resolved &&
    warnings.every(
      (warning) => !warning.requires_ack || acks.includes(warning.warning_id),
    )
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text)
      setCopyNotice('문구를 복사했어요.')
    } catch {
      setCopyNotice(
        '자동으로 복사하지 못했어요. 아래 문구를 직접 선택해 복사해 주세요.',
      )
    }
  }
  return (
    <section className="panel results-panel" aria-label="계산 결과와 최종 저장">
      <div className="panel-header">
        <div className="section-heading">
          <span className="section-number">02</span>
          <h2>결과 비교</h2>
        </div>
        <span className="status-pill">
          {saved
            ? '저장 완료'
            : (result ?? operation)?.response_status === 'ok'
              ? '비교할 준비 완료'
              : (result ?? operation)
                ? '조건 확인 필요'
                : '계산 전'}
        </span>
      </div>
      <ResultExplanation
        resultId={result?.result_id ?? operation?.result_id ?? null}
        eligible={!!validResult || operation?.response_status === 'ok'}
        busy={!!busy}
        choiceLabels={choiceLabels}
        subject={type === 'operation' ? '세 운영안을 비교' : '구매안을 계산'}
      />
      {saved && (
        <div className="saved-banner">
          <Icon name="check" />
          <div>
            <strong>이 조건의 계획을 저장했어요</strong>
            <p>확정 당시의 내용을 다시 확인할 수 있어요.</p>
            <button
              className="text-button"
              onClick={() => onSaved(saved.confirmation_id)}
            >
              저장한 계획 보기 <Icon name="arrow" size={15} />
            </button>
          </div>
        </div>
      )}
      {/* 운영 결과 비교 화면. 구매 결과 표시는 아래 그대로 */}
      {operation ? (
        operation.response_status !== 'ok' ? (
          <div className="result-feedback">
            <Alert>
              {operation.summary.message ?? '조건을 확인하고 다시 계산해 주세요.'}
            </Alert>
            {operation.summary.missing_fields?.map((field) => (
              <p key={field.path}>{field.label}</p>
            ))}
            {operation.summary.violations?.map((violation, i) => (
              <p key={i}>{violation.message}</p>
            ))}
            <button className="button secondary" disabled={!!busy} onClick={onEdit}>
              조건 수정하기
            </button>
          </div>
        ) : (
          <OperationComparison
            result={operation}
            input={input}
            savedChoice={saved?.selected_choice_key ?? null}
            valid={
              !!context?.input_confirmed &&
              operation.is_latest_version &&
              operation.input_version_id === context.current_version_id
            }
            busy={!!busy}
            onConfirm={(choice, warnings) => workspace.confirm(choice, warnings)}
            onEdit={onEdit}
          />
        )
      ) : !result ? (
        <div className="result-placeholder">
          <div className="result-illustration" aria-hidden="true">
            <div className="mini-card">
              <span />
              <b />
              <i />
              <i />
            </div>
            <div className="mini-card second">
              <span />
              <b />
              <i />
              <i />
            </div>
            <span className="mini-check">
              <Icon name="check" size={17} />
            </span>
          </div>
          <h3>
            {pending ? (
              '새 조건을 확인하고 있어요.'
            ) : (
              <>
                조건을 확인하면
                <br />
                선택지가 선명해져요.
              </>
            )}
          </h3>
          <p>
            {pending
              ? '빠진 입력을 채운 뒤 새 조건을 확인하고 다시 계산해 주세요. 이전 계획은 저장한 계획에서 볼 수 있어요.'
              : type === 'operation'
                ? '입력 확인 후 계산하면, 세 운영안의 대기시간과 인건비를 같은 손님 조건으로 여기에서 비교해요.'
                : '입력 확인 후 계산하면, 조건에 맞는 구매안과 거래처별 목록을 여기에서 비교해요.'}
          </p>
          <div className="placeholder-note">
            <Icon name="box" size={17} />
            <span>
              계획 저장까지 도와드려요.
              <br />
              {type === 'operation'
                ? '근무표 적용과 채용은 사장님이 직접 진행해 주세요.'
                : '발주와 결제는 사장님이 직접 진행해 주세요.'}
            </span>
          </div>
        </div>
      ) : (
        <>
          {result.response_status !== 'ok' ? (
            <div className="result-feedback">
              <Alert>
                {result.summary.message ??
                  '조건을 확인하고 다시 계산해 주세요.'}
              </Alert>
              {result.summary.missing_fields?.map((field) => (
                <p key={field.path}>{field.label}</p>
              ))}
              {result.response_status === 'infeasible' &&
                !!result.summary.suggested_changes?.length && (
                  <section aria-label="조건 변경 제안">
                    <h3>계산을 위해 이런 변경을 제안해요</h3>
                    <ul>
                      {result.summary.suggested_changes.map((change) => (
                        <li key={change.path}>
                          {change.label} →{' '}
                          {amount(change.suggested, change.unit ?? '', {
                            maximumSignificantDigits: 21,
                          })}
                        </li>
                      ))}
                    </ul>
                    <p className="muted">
                      조건 수정하기에서 제안 값을 검토하고 직접 입력해 주세요.
                    </p>
                  </section>
                )}
              <button
                className="button secondary"
                disabled={!!busy}
                onClick={onEdit}
              >
                조건 수정하기
              </button>
            </div>
          ) : (
            <>
              <div className="result-intro">
                <p className="eyebrow">사장님이 직접 비교하고 선택해 주세요</p>
                <p>
                  {saved
                    ? '확정한 안과 계산 당시의 대안을 확인하세요.'
                    : '조건을 만족하는 안을 살펴보세요. 최종 선택 전까지 저장되지 않아요.'}
                </p>
              </div>
              <div
                className="choice-grid"
                role="radiogroup"
                aria-label="구매안 선택"
              >
                {choices.map((item, i) => {
                  const value = resolveChoice(item, choices)
                  return (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={selected === item.choice_key}
                      aria-disabled={
                        !value || !validResult || !!saved || !!busy
                      }
                      disabled={!value || !validResult || !!saved || !!busy}
                      key={item.choice_key}
                      className={`choice-card ${selected === item.choice_key ? 'selected' : ''}`}
                      onClick={() => {
                        setSelected(item.choice_key)
                        setAcks([])
                        setCopyNotice('')
                      }}
                    >
                      <div className="choice-top">
                        <span>대안 {i + 1}</span>
                        <span className="radio-dot">
                          {selected === item.choice_key && (
                            <Icon name="check" size={12} />
                          )}
                        </span>
                      </div>
                      <h3>{item.label ?? item.choice_key}</h3>
                      <strong className="choice-price">
                        {value ? amount(value.total_krw) : '선택 불가'}
                      </strong>
                      <small>
                        {value
                          ? `배송 ${value.delivery_count ?? '—'}회${item.same_as ? ' · 앞선 안과 동일' : ''}`
                          : (item.unavailable_reason ??
                            '현재 조건에서는 만들 수 없어요.')}
                      </small>
                    </button>
                  )
                })}
              </div>
              {!validResult && !saved && (
                <Alert error>
                  조건이 바뀌었어요. 입력을 다시 확인한 뒤 계산해 주세요.
                </Alert>
              )}
              {choice && resolved ? (
                <div className="choice-details">
                  <div className="section-heading">
                    <Icon name="box" size={18} />
                    <h3>거래처별 구매 목록</h3>
                  </div>
                  <PurchaseLines lines={detail?.lines ?? []} input={input} />
                  {typeof resolved.diff_from_baseline_krw === 'number' && (
                    <p className="muted">
                      비교용 기준선과의 차이{' '}
                      {amount(resolved.diff_from_baseline_krw)} · 기준선은
                      확정할 수 없어요.
                    </p>
                  )}
                  <div className="warning-list">
                    {warnings.map((warning) => (
                      <label
                        className={`warning ${warning.requires_ack ? 'required' : ''}`}
                        key={warning.warning_id}
                      >
                        {warning.requires_ack ? (
                          <input
                            type="checkbox"
                            checked={
                              !!saved || acks.includes(warning.warning_id)
                            }
                            disabled={!!busy || !!saved}
                            onChange={(e) =>
                              setAcks((previous) =>
                                e.target.checked
                                  ? [...previous, warning.warning_id]
                                  : previous.filter(
                                      (id) => id !== warning.warning_id,
                                    ),
                              )
                            }
                          />
                        ) : (
                          <span aria-hidden="true">ⓘ</span>
                        )}
                        <span>
                          <b>{warning.requires_ack ? '확인 필요' : '참고'}</b>
                          {warning.message}
                        </span>
                      </label>
                    ))}
                  </div>
                  {detail?.order_messages?.map((message) => (
                    <details className="order-draft" key={message.supplier_id}>
                      <summary>
                        거래처에 보낼 문구 초안 <span>직접 확인 후 사용</span>
                      </summary>
                      <pre>{message.text}</pre>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => copy(message.text)}
                      >
                        문구 복사
                      </button>
                    </details>
                  ))}
                  {copyNotice && (
                    <p role="status" className="muted">
                      {copyNotice}
                    </p>
                  )}
                </div>
              ) : (
                <p className="choose-prompt">
                  <Icon name="arrow" size={16} />
                  대안을 선택하면 구매 목록을 볼 수 있어요.
                </p>
              )}
              <div className="result-footer">
                <button
                  className="button secondary"
                  disabled={!!busy}
                  onClick={onEdit}
                >
                  조건 수정
                </button>
                <button
                  className="button primary"
                  disabled={!canSave || !!busy}
                  onClick={() => workspace.confirm(selected, acks)}
                >
                  {busy
                    ? '처리 중…'
                    : saved
                      ? '확정·저장 완료'
                      : '선택한 안으로 확정·저장'}
                  <Icon name="check" size={16} />
                </button>
                <p>계획을 저장하며, 실제 발주·결제는 진행하지 않아요.</p>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}
export function ConfirmationModal({
  id,
  onClose,
  onDeleted,
}: {
  id: number
  onClose: () => void
  onDeleted?: (id: number) => void
}) {
  const [detail, setDetail] = useState<ConfirmationDetail | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    workflowApi
      .confirmation(id)
      .then((value) => {
        if (active) setDetail(value)
      })
      .catch((cause) => {
        if (active)
          setError(
            cause instanceof Error
              ? cause.message
              : '저장한 계획을 불러오지 못했어요.',
          )
      })
    return () => {
      active = false
    }
  }, [id])
  const snapshot = detail?.selected_snapshot_json ?? {}
  const choice = Object.keys(object(snapshot.choice)).length
    ? object(snapshot.choice)
    : snapshot
  const savedDetail = object(snapshot.detail)
  const lines = savedDetail.lines
  const orderMessages = Array.isArray(savedDetail.order_messages)
    ? savedDetail.order_messages.map(object)
    : []
  const warnings = Array.isArray(snapshot.warnings)
    ? snapshot.warnings.map(object)
    : []
  return (
    <Modal
      title="저장한 계획"
      description="확정 당시 저장된 내용을 그대로 보여드려요."
      wide
      onClose={onClose}
    >
      {error ? (
        <Alert error>{error}</Alert>
      ) : !detail ? (
        <p className="loading" role="status">
          계획을 불러오고 있어요…
        </p>
      ) : (
        <div className="confirmation-detail">
          <DeleteConfirmation id={id} onDeleted={(deleted) => { onDeleted?.(deleted); onClose() }} />
          <div className="detail-badges">
            <span className="status-pill">
              {featureName(detail.feature_type)}
            </span>
            <span
              className={`status-pill ${detail.is_current_version ? 'green' : ''}`}
            >
              {detail.is_current_version
                ? '현재 조건의 확정'
                : '과거 확정 이력'}
            </span>
          </div>
          <h3>
            {String(
              choice.label ??
                (detail.feature_type === 'purchase'
                  ? '구매 계획'
                  : `운영 계획 · ${CHOICE_TITLE[choice.choice_key as keyof typeof CHOICE_TITLE] ?? ''}`),
            )}
          </h3>
          {typeof choice.total_krw === 'number' && (
            <p className="detail-price">{amount(choice.total_krw)}</p>
          )}
          <p className="muted">{dateTime(detail.confirmed_at)} 저장</p>
          {!detail.is_current_version && (
            <Alert>
              이후 조건이 바뀌었어요. 이 계획은 과거 기록으로 보관돼 있어요.
            </Alert>
          )}
          {Array.isArray(lines) && (
            <PurchaseLines lines={lines.map(object)} input={null} />
          )}
          {orderMessages.map((message, index) => (
            <details className="order-draft" key={index}>
              <summary>저장 당시의 거래처별 문구</summary>
              <pre>{String(message.text ?? '')}</pre>
            </details>
          ))}
          {/* 확정한 운영안 요약 */}
          {detail.feature_type === 'operation' && (
            <OperationConfirmationSummary choice={choice} />
          )}
          {detail.feature_type === 'operation' && (
            <Alert>
              모의 조건으로 계산한 운영 계획이에요. 실제 운영 성과를 보장하지
              않아요.
            </Alert>
          )}
          <div className="warning-list">
            {warnings.map((warning, index) => {
              const acknowledged = detail.acknowledged_warnings_json.some(
                (value) =>
                  (typeof value === 'string' ? value : value.warning_id) ===
                  warning.warning_id,
              )
              return (
                <div className="warning" key={index}>
                  <Icon name="check" size={17} />
                  <span>
                    {String(warning.message ?? '저장된 경고')}
                    <small>
                      {acknowledged ? '확인하고 저장한 경고' : '참고 경고'}
                    </small>
                  </span>
                </div>
              )
            })}
          </div>
          {Array.isArray(snapshot.assumptions) &&
            snapshot.assumptions.length > 0 && (
              <div className="assumptions">
                <h4>당시 적용한 가정</h4>
                <ul>
                  {snapshot.assumptions.map((value, i) => (
                    <li key={i}>{String(value)}</li>
                  ))}
                </ul>
              </div>
            )}
          <p className="muted">
            저장 번호 #{detail.confirmation_id} · 실제 발주·결제·근무표 적용은
            진행하지 않았어요.
          </p>
        </div>
      )}
    </Modal>
  )
}
