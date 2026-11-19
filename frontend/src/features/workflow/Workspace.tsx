import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { FeatureType } from '../../types/api'
import { Alert, Icon, Modal } from '../../components/common/Ui'
import type { JsonObject } from '../../types/workflow'
import {
  amount,
  currentQuestion,
  questionDraft,
  fieldName,
  dateTime,
  featureName,
  object,
  visibleMessages,
} from './model'
import type { WorkspaceController } from './useWorkspace'
import PurchaseForm from './PurchaseForm'
import Results from './Results'
// 운영 실험 폼·입력 확인 화면 연결
import OperationForm from '../operation/workspace/OperationForm'
import OperationInputReview from '../operation/workspace/OperationInputReview'
import { isOperationDraft } from '../operation/workspace/operationInput'

export function NewSession({
  feature,
  busy,
  onCreate,
  onClose,
  error,
}: {
  error: string
  feature: FeatureType
  busy: boolean
  onCreate: (
    feature: FeatureType,
    method: 'agent' | 'form',
    title: string,
  ) => Promise<void>
  onClose: () => void
}) {
  const [type, setType] = useState(feature)
  const [method, setMethod] = useState<'agent' | 'form'>('agent')
  const [title, setTitle] = useState('')
  return (
    <Modal
      title="어떤 업무를 시작할까요?"
      description="업무마다 대화와 입력 조건을 나누어 저장해요."
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void onCreate(type, method, title.trim())
        }}
        className="new-session-form"
      >
        <fieldset disabled={busy}>
          {error && <Alert error>{error}</Alert>}
          <div className="session-type-options">
            {(['purchase', 'operation'] as const).map((value) => (
              <button
                type="button"
                className={`session-type ${type === value ? 'selected' : ''}`}
                aria-pressed={type === value}
                key={value}
                onClick={() => setType(value)}
              >
                <Icon name={value === 'purchase' ? 'box' : 'clock'} size={24} />
                <strong>{featureName(value)}</strong>
                <small>
                  {value === 'purchase'
                    ? '필요한 만큼, 조건에 맞게'
                    : '우리 매장의 운영 조건 정리'}
                </small>
              </button>
            ))}
          </div>
          <label>
            업무 이름 <span className="muted">선택</span>
            <input
              maxLength={200}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={
                type === 'purchase'
                  ? '예: 이번 주 매입 준비'
                  : '예: 점심 시간 운영 실험'
              }
            />
          </label>
          <div className="input-methods" role="group" aria-label="입력 방식">
            <button
              type="button"
              aria-pressed={method === 'agent'}
              className={method === 'agent' ? 'active' : ''}
              onClick={() => setMethod('agent')}
            >
              대화로 시작
            </button>
            <button
              type="button"
              aria-pressed={method === 'form'}
              className={method === 'form' ? 'active' : ''}
              onClick={() => setMethod('form')}
            >
              폼으로 직접 입력
            </button>
          </div>
          {type === 'operation' && (
            <p className="muted">
              대화로 "하루 150건 정도, 사장님도 일해요"처럼 말씀하시면 조건을 채워 드려요.
              폼으로 직접 넣어도 돼요. 채운 뒤에도 대화나 폼으로 바꿀 수 있어요.
            </p>
          )}
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              취소
            </button>
            <button type="submit" className="button primary">
              {busy ? '준비 중…' : '업무 시작하기'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
function Progress({ workspace }: { workspace: WorkspaceController }) {
  const { context, saved, input, result, operation } = workspace
  const pending = currentQuestion(workspace.messages, context)
  const step = pending
    ? 2
    : saved
      ? 5
      : result?.response_status === 'ok' || operation?.response_status === 'ok'
        ? 4
        : context?.input_confirmed
          ? 3
          : context?.current_version_id
            ? 2
            : 1
  return (
    <aside className="progress-column" aria-label="업무 진행 단계">
      <p className="eyebrow">WORKFLOW</p>
      <h2>
        차근차근,
        <br />한 단계씩
      </h2>
      <ol className="steps">
        {[
          '조건 입력',
          '질문·입력 확인',
          '계산 실행',
          '대안 비교',
          '확정·저장',
        ].map((label, i) => (
          <li
            className={i + 1 === step ? 'current' : i + 1 < step ? 'done' : ''}
            key={label}
            aria-current={i + 1 === step ? 'step' : undefined}
          >
            <span className="step-dot">
              {i + 1 < step ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span>
              {label}
              {i + 1 === step && <small>지금 이 단계예요</small>}
            </span>
          </li>
        ))}
      </ol>
      <div className="conditions-summary">
        <div className="eyebrow">
          <span
            className={`tiny-dot ${context?.input_confirmed ? 'green' : ''}`}
          />
          {pending
            ? '새 조건 확인 중'
            : context?.input_confirmed
              ? '확인한 조건'
              : '입력한 조건'}
        </div>
        {!pending && input && context?.feature_type === 'purchase' ? (
          <dl>
            <div>
              <dt>예산</dt>
              <dd>{amount(input.budget_krw)}</dd>
            </div>
            <div>
              <dt>계획 기간</dt>
              <dd>{amount(input.planning_days, '일')}</dd>
            </div>
            <div>
              <dt>배송 상한</dt>
              <dd>{amount(input.max_delivery_count, '회')}</dd>
            </div>
          </dl>
        ) : !pending && input && context?.feature_type === 'operation' ? (
          <dl>
            {/* 운영 입력 요약(하루 주문·라스트 오더·비교할 안) */}
            <div>
              <dt>하루 주문</dt>
              <dd>{amount(object(object(input.simulation).scenario).daily_orders, '건')}</dd>
            </div>
            <div>
              <dt>라스트 오더</dt>
              <dd>{String(object(object(input.simulation).scenario).last_order_time ?? '18:45')}</dd>
            </div>
            <div>
              <dt>비교할 안</dt>
              <dd>현재 · 서로 돕기 · 한 명 추가</dd>
            </div>
          </dl>
        ) : (
          <p>
            {pending
              ? '빠진 입력을 채우면 새 조건으로 검토할 수 있어요.'
              : context?.current_version_id
                ? '서버에 저장된 입력이 있어요.'
                : '입력을 저장하면 조건을 여기서 확인할 수 있어요.'}
          </p>
        )}
        <small>
          {context?.input_confirmed
            ? '조건을 수정하면 다시 확인받아요.'
            : '모르는 값은 임의로 채우지 않아요.'}
        </small>
      </div>
      <p className="safety-note">
        <Icon name="check" size={15} />
        계획의 마지막 결정은
        <br />
        사장님이 직접 해 주세요.
      </p>
    </aside>
  )
}
function InputReview({
  workspace,
  onEdit,
}: {
  workspace: WorkspaceController
  onEdit: () => void
}) {
  const { context, input, busy, saved } = workspace
  if (
    !context?.current_version_id ||
    currentQuestion(workspace.messages, context)
  )
    return null
  const purchase = context.feature_type === 'purchase'
  const items = Array.isArray(input?.items) ? input.items.map(object) : []
  return (
    <section className="review-card" aria-label="입력 검토">
      <div className="choice-top">
        <h3>계산 전, 이 조건이 맞나요?</h3>
        <span
          className={`status-pill ${context.input_confirmed ? 'green' : ''}`}
        >
          {context.input_confirmed
            ? '입력 확인 완료'
            : `입력 ${context.current_version}`}
        </span>
      </div>
      {/* 운영은 운영 입력 확인 화면을 보여 준다 */}
      {!purchase ? (
        <OperationInputReview input={input} confirmed={context.input_confirmed} />
      ) : input ? (
        <>
          <div className="review-totals">
            <div>
              <small>예산</small>
              <b>{amount(input.budget_krw)}</b>
            </div>
            <div>
              <small>기간 / 배송</small>
              <b>
                {amount(input.planning_days, '일')} /{' '}
                {amount(input.max_delivery_count, '회')}
              </b>
            </div>
          </div>
          {items.length > 0 && (
            <div className="table-scroll">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>품목</th>
                    <th>필요 총량</th>
                    <th>현재 재고</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => (
                    <tr key={i}>
                      <td>{String(item.item_name ?? '품목')}</td>
                      <td>
                        {amount(item.gross_need, String(item.base_unit ?? ''))}
                      </td>
                      <td>
                        {amount(
                          item.usable_inventory,
                          String(item.base_unit ?? ''),
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : (
        <p className="muted">
          이 업무의 입력 요약을 대화에서 찾지 못했어요.{' '}
          {context.input_confirmed
            ? '이전에 확인한 저장 조건으로 계산할 수 있어요.'
            : '조건을 다시 입력하고 검토해 주세요.'}
        </p>
      )}
      <div className="review-actions">
        <button
          className="text-button"
          type="button"
          disabled={!!busy}
          onClick={onEdit}
        >
          조건 수정
        </button>
        {/* 운영은 입력 확인과 계산을 '세 운영안 비교하기' 한 번으로 한다 */}
        {!context.input_confirmed && context.feature_type !== 'operation' ? (
          <button
            className="button primary"
            disabled={!!busy || !input}
            onClick={() => workspace.confirmInput()}
          >
            이 조건으로 계산해도 좋아요{' '}
            <Icon name="check" size={15} />
          </button>
        ) : (
          <button
            className="button primary"
            disabled={
              !!busy ||
              !!saved ||
              (context.feature_type === 'operation' && isOperationDraft(input))
            }
            onClick={() => workspace.calculate()}
          >
            {saved
              ? '이미 저장한 조건이에요'
              : purchase
                ? '구매안 계산하기'
                : '세 운영안 비교하기'}
            <Icon name="arrow" size={15} />
          </button>
        )}
      </div>
    </section>
  )
}
export default function Workspace({
  workspace,
  feature,
  onFeature,
  onNew,
  onHistory,
  onSaved,
}: {
  workspace: WorkspaceController
  feature: FeatureType
  onFeature: (feature: FeatureType) => void
  onNew: () => void
  onHistory: () => void
  onSaved: (id: number) => void
}) {
  const { context, busy, messages } = workspace
  const [formOpen, setFormOpen] = useState(
    () => context?.input_method === 'form' && !context.current_version_id,
  )
  const [draft, setDraft] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<number | null>(null)
  const question = currentQuestion(messages, context)
  const bottom = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (messages.length || busy)
      bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [messages.length, busy])
  async function send(e: FormEvent, answer?: string) {
    e.preventDefault()
    const text = (answer ?? draft).trim()
    if (!text || !context) return
    const body: JsonObject = question
      ? {
          event_type: 'question_reply',
          question_id: question.question_id,
          answer: text,
        }
      : { event_type: 'message', content: text }
    if (await workspace.event(body)) setDraft('')
  }
  function edit() {
    if (context) setFormOpen(true)
  }
  return (
    <>
      <div className="workspace-heading">
        <div>
          <p className="eyebrow">OUR DAILY WORKSPACE</p>
          <h1>
            {context?.title ||
              (feature === 'purchase'
                ? '이번 주 매입, 차근차근 준비해요.'
                : '우리 매장의 운영을 살펴봐요.')}
          </h1>
          <p>조건을 정리하고, 비교하고, 사장님이 결정하세요.</p>
        </div>
        <div className="workspace-actions">
          <button
            className="button secondary"
            disabled={!!busy}
            onClick={onHistory}
          >
            <Icon name="clock" size={17} />
            이어하기
          </button>
          <button className="button primary" disabled={!!busy} onClick={onNew}>
            <Icon name="plus" size={17} />새 업무
          </button>
        </div>
      </div>
      <div className="workspace-toolbar">
        <div className="feature-tabs" role="group" aria-label="업무 종류">
          <button
            aria-pressed={feature === 'purchase'}
            className={feature === 'purchase' ? 'active' : ''}
            disabled={!!busy}
            onClick={() => onFeature('purchase')}
          >
            <Icon name="box" size={17} />
            매입·재고
          </button>
          <button
            aria-pressed={feature === 'operation'}
            className={feature === 'operation' ? 'active' : ''}
            disabled={!!busy}
            onClick={() => onFeature('operation')}
          >
            <Icon name="clock" size={17} />
            운영 실험
          </button>
        </div>
        <div className="session-meta">
          {context ? (
            <>
              <span className="tiny-dot green" />
              마지막 저장 · {dateTime(context.updated_at)}
              <button
                className="icon-button"
                disabled={!!busy}
                aria-label="현재 업무 새로고침"
                onClick={() => workspace.open(context.session_id)}
              >
                <Icon name="refresh" size={16} />
              </button>
            </>
          ) : (
            <span>새 업무를 시작하거나 하던 업무를 이어 보세요</span>
          )}
        </div>
      </div>
      {workspace.error && (
        <Alert error>
          {workspace.error}
          <button
            className="icon-button"
            aria-label="오류 안내 닫기"
            onClick={workspace.dismissError}
          >
            <Icon name="close" size={16} />
          </button>
        </Alert>
      )}
      {workspace.notice && (
        <div className="notice" role="status">
          <Icon name="check" size={16} />
          {workspace.notice}
        </div>
      )}
      {workspace.pendingEvent && !busy && (
        <Alert>
          입력 요청의 응답을 받지 못했어요. 같은 요청으로 처리 여부를 확인할 수
          있어요.
          <button
            className="button secondary"
            onClick={() => workspace.retryEvent()}
          >
            재전송하여 처리 확인
          </button>
        </Alert>
      )}
      <div className="workspace-grid">
        <Progress workspace={workspace} />
        <section
          className="panel conversation-panel"
          aria-label="업무 대화와 입력"
        >
          <div className="panel-header">
            <div className="section-heading">
              <span className="section-number">01</span>
              <h2>함께 조건 정리하기</h2>
            </div>
            <span className="live-label">
              <span className={`tiny-dot ${context ? 'green' : ''}`} />
              {context ? '대화 저장됨' : '대화 준비'}
            </span>
          </div>
          <div className="conversation-feed">
            <div className="assistant-welcome">
              <span className="assistant-avatar">
                S<span>✦</span>
              </span>
              <p className="eyebrow">사장님의 결정을 돕는 SOL루션</p>
              <h3>
                {context
                  ? '어떤 조건으로 준비할까요?'
                  : '복잡한 준비는 가볍게,\n결정은 사장님답게.'}
              </h3>
              <p>
                {context
                  ? feature === 'purchase'
                    ? '필요한 재료와 재고, 예산을 알려주세요. 모르는 값은 확인하고 진행할게요.'
                    : '살펴보고 싶은 시간대와 매장 운영 조건을 알려주세요. 업무별로 대화를 저장해요.'
                  : '매장 상황을 대화로 남기거나 폼으로 입력해 보세요. 조건을 확인한 뒤 계산하고 계획을 저장할 수 있어요.'}
              </p>
              {!context && (
                <div className="welcome-actions">
                  <button
                    className="button primary"
                    disabled={!!busy}
                    onClick={onNew}
                  >
                    첫 업무 시작하기 <Icon name="arrow" size={16} />
                  </button>
                  <button
                    className="text-button"
                    disabled={!!busy}
                    onClick={onHistory}
                  >
                    하던 업무 이어하기
                  </button>
                </div>
              )}
            </div>
            {visibleMessages(messages)
              .filter((message) => !(question && message.role === 'assistant' &&
                message.metadata_json?.question_id === question.question_id &&
                message.content.trim() === question.question?.text?.trim()))
              .map((message) => (
                <div
                  className={`message ${message.role}`}
                  key={message.message_id}
                >
                  {message.role === 'assistant' && (
                    <span className="message-avatar">S</span>
                  )}
                  <div>
                    <small>
                      {message.role === 'user' ? '사장님' : 'SOL루션'} ·{' '}
                      {dateTime(message.created_at)}
                    </small>
                    <p>
                      {message.content === '(폼 입력)'
                        ? '폼으로 입력 조건을 저장했어요.'
                        : message.content}
                    </p>
                    <button type="button" className="text-button delete-action" disabled={!!busy}
                      aria-label={`${message.role === 'user' ? '내' : 'AI'} 대화 삭제`}
                      onClick={() => setDeleteTarget(message.message_id)}>대화 삭제</button>
                  </div>
                </div>
              ))}
            {question && (
              <div className="question-card">
                <p className="eyebrow">한 가지만 더 확인할게요</p>
                <h3>{question.question?.text ?? '빠진 입력을 알려 주세요.'}</h3>
                {question.missing_fields?.filter((field) =>
                  fieldName(field.path, field.label).trim() !== question.question?.text?.trim(),
                ).map((field) => (
                  <p className="muted" key={field.path}>
                    {fieldName(field.path, field.label)}
                  </p>
                ))}
                <div className="question-options">
                  {question.question?.choices?.map((answer) => (
                    <button
                      className="button secondary"
                      key={answer}
                      disabled={!!busy}
                      onClick={(e) => send(e, answer)}
                    >
                      {fieldName(answer, answer)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <InputReview workspace={workspace} onEdit={edit} />
            {busy && (
              <div className="busy-line" role="status">
                <span className="spinner" />
                {busy}
              </div>
            )}
            <div ref={bottom} />
          </div>
          <div className="composer">
            {deleteTarget !== null && (
              <section className="delete-confirm" aria-label="대화 삭제 확인">
                <strong>이 대화를 삭제할까요?</strong>
                <p>대화 표시만 삭제돼요. 입력 조건·현재 확인 질문·계산 결과·저장한 계획은 유지돼요.</p>
                <button className="button secondary" disabled={!!busy} onClick={() => setDeleteTarget(null)}>취소</button>
                <button className="button primary" disabled={!!busy} onClick={() => {
                  void workspace.deleteMessage(deleteTarget).then((ok) => { if (ok) setDeleteTarget(null) })
                }}>대화 삭제</button>
              </section>
            )}
            <div className="composer-toolbar">
              <span>
                {question ? '질문에 답해 주세요' : '사장님 말씀을 남겨 주세요'}
              </span>
              <button
                className="text-button"
                disabled={!context || !!busy}
                onClick={edit}
              >
                폼으로 직접 입력
              </button>
            </div>
            <form onSubmit={send}>
              <label className="sr-only" htmlFor="message">
                {question ? '질문에 대한 답변' : '메시지'}
              </label>
              <textarea
                id="message"
                rows={2}
                placeholder={
                  !context
                    ? '새 업무를 시작하면 대화할 수 있어요'
                    : context.feature_type === 'operation'
                      ? context.current_version_id
                        ? '예: 하루 주문을 50건 늘려줘'
                        : '예: 하루 150건 정도, 사장님도 일해요'
                      : '예: 이번 주 예산을 15만 원으로 바꿔줘'
                }
                disabled={!context || !!busy}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault()
                    void send(e)
                  }
                }}
              />
              <button
                type="submit"
                className="send-button"
                aria-label="메시지 보내기"
                disabled={!context || !!busy || !draft.trim()}
              >
                <Icon name="arrow" size={20} />
              </button>
            </form>
            <small>
              입력 확인 전에는 계산하지 않아요. 모르는 값은 폼에서 비워 둘 수
              있어요.
            </small>
          </div>
        </section>
        <Results
          feature={feature}
          key={`${context?.current_version_id}:${workspace.result?.result_id}:${workspace.operation?.result_id}`}
          workspace={workspace}
          onEdit={edit}
          onSaved={onSaved}
        />
      </div>
      {formOpen && context?.feature_type === 'purchase' && (
        <PurchaseForm
          serverError={workspace.error}
          key={`${context.session_id}:${context.current_version_id}`}
          initial={questionDraft(messages, context) ?? workspace.input}
          busy={!!busy}
          onSave={(input) =>
            workspace.event({ event_type: 'form', form_input: input })
          }
          onClose={() => setFormOpen(false)}
        />
      )}
      {/* 운영 실험 폼 */}
      {formOpen && context?.feature_type === 'operation' && (
        <OperationForm
          serverError={workspace.error}
          key={`${context.session_id}:${context.current_version_id}`}
          initial={questionDraft(messages, context) ?? workspace.input}
          busy={!!busy}
          onSave={(input) =>
            workspace.event({ event_type: 'form', form_input: input })
          }
          onClose={() => setFormOpen(false)}
        />
      )}
    </>
  )
}
