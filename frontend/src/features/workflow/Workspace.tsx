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
} from './model'
import type { WorkspaceController } from './useWorkspace'
import PurchaseForm from './PurchaseForm'
import Results from './Results'

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
                onClick={() => {
                  setType(value)
                  if (value === 'operation') setMethod('agent')
                }}
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
          {/* 말로 하기를 기본으로 두고, 표 입력은 원하는 분만 고르도록 작게 둔다. */}
          <p className="input-method-note">
            {method === 'agent'
              ? '말로 알려 주시면 SOL루션이 정리해 드려요.'
              : '표에 직접 적어서 시작해요.'}{' '}
            {type === 'purchase' && (
              <button
                type="button"
                className="text-button"
                aria-pressed={method === 'form'}
                onClick={() =>
                  setMethod(method === 'agent' ? 'form' : 'agent')
                }
              >
                {method === 'agent' ? '표에 직접 적을게요' : '말로 할게요'}
              </button>
            )}
          </p>
          {type === 'operation' && (
            <p className="muted">
              운영 업무·대화 저장은 가능하며, 설정 폼과 계산은 운영 기능에
              연결할 예정이에요.
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
              {busy ? '준비 중…' : '시작하기'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
function Progress({ workspace }: { workspace: WorkspaceController }) {
  const { context, saved, input, result } = workspace
  const pending = currentQuestion(workspace.messages, context)
  const step = pending
    ? 2
    : saved
      ? 5
      : result?.response_status === 'ok'
        ? 4
        : context?.input_confirmed
          ? 3
          : context?.current_version_id
            ? 2
            : 1
  const labels = [
    '조건 말하기',
    '질문에 답하기',
    '계산하기',
    '안 고르기',
    '저장하기',
  ]
  return (
    <aside className="progress-column" aria-label="업무 진행 단계">
      {/* 한 줄 흐름: 지금 몇 번째 단계인지 먼저 한 문장으로 알려 준다. */}
      <p className="progress-now">
        지금 <b>{step}단계</b> / 5단계 · {labels[step - 1]}
      </p>
      <ol className="steps">
        {labels.map((label, i) => (
          <li
            className={i + 1 === step ? 'current' : i + 1 < step ? 'done' : ''}
            key={label}
            aria-current={i + 1 === step ? 'step' : undefined}
          >
            <span className="step-dot">
              {i + 1 < step ? <Icon name="check" size={14} /> : i + 1}
            </span>
            <span>{label}</span>
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
          {context.input_confirmed ? '확인했어요' : '확인 전'}
        </span>
      </div>
      {!purchase ? (
        <p className="muted">
          운영 조건 검토 화면은 운영 설정 기능과 연결할 예정이에요.
        </p>
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
          {context.input_confirmed
            ? '저장해 둔 조건으로 바로 계산할 수 있어요.'
            : '조건을 다시 알려 주세요.'}
        </p>
      )}
      <div className="review-actions">
        <button
          className="text-button"
          type="button"
          disabled={!!busy || context.feature_type === 'operation'}
          onClick={onEdit}
        >
          조건 수정
        </button>
        {!context.input_confirmed ? (
          <button
            className="button primary"
            disabled={!!busy || !input || !purchase}
            onClick={() => workspace.confirmInput()}
          >
            {purchase
              ? '이 조건으로 계산해도 좋아요'
              : '운영 조건 확인 연결 예정'}{' '}
            <Icon name="check" size={15} />
          </button>
        ) : (
          <button
            className="button primary"
            disabled={!!busy || context.feature_type !== 'purchase' || !!saved}
            onClick={() => workspace.calculate()}
          >
            {context.feature_type === 'operation'
              ? '운영 계산 연결 예정'
              : saved
                ? '이미 저장한 조건이에요'
                : '구매안 계산하기'}
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
    if (context?.feature_type === 'purchase') setFormOpen(true)
  }
  return (
    <>
      <div className="workspace-heading">
        <div>
          <h1>
            {context?.title ||
              (feature === 'purchase'
                ? '이번 주 매입, 차근차근 준비해요.'
                : '우리 매장의 운영을 살펴봐요.')}
          </h1>
          <p>조건을 정리하고, 비교하고, 사장님이 결정하세요.</p>
        </div>
        {/* 업무를 열기 전에는 아래 큰 버튼(말로 시작하기·하던 업무 이어하기)과 겹쳐 숨긴다. */}
        {context && (
          <div className="workspace-actions">
            <button
              className="button secondary"
              disabled={!!busy}
              onClick={onHistory}
            >
              <Icon name="clock" size={17} />
              하던 업무
            </button>
            <button className="button primary" disabled={!!busy} onClick={onNew}>
              <Icon name="plus" size={17} />새 업무
            </button>
          </div>
        )}
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
                  : '매장 상황을 말로 알려 주세요. SOL루션이 정리하고, 계산해서, 고를 수 있게 보여 드려요.'}
              </p>
              {!context && (
                <div className="welcome-actions">
                  <button
                    className="button primary"
                    disabled={!!busy}
                    onClick={onNew}
                  >
                    말로 시작하기 <Icon name="arrow" size={16} />
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
            {messages
              .filter(
                (message) =>
                  message.role === 'user' || message.role === 'assistant',
              )
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
                  </div>
                </div>
              ))}
            {question && (
              <div className="question-card">
                <p className="eyebrow">한 가지만 더 확인할게요</p>
                <h3>{question.question?.text ?? '빠진 입력을 알려 주세요.'}</h3>
                {question.missing_fields?.map((field) => (
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
                      {answer}
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
          {/* 업무를 시작하기 전에는 쓸 수 없는 입력칸이라 숨긴다. */}
          {context && (
            <div className="composer">
              <div className="composer-toolbar">
                <span>
                  {question ? '질문에 답해 주세요' : '사장님 말씀을 남겨 주세요'}
                </span>
                {feature === 'purchase' && (
                  <button
                    className="text-button"
                    disabled={!context || !!busy}
                    onClick={edit}
                  >
                    표에 직접 적기
                  </button>
                )}
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
                      : feature === 'purchase'
                        ? '예: 이번 주 예산을 15만 원으로 바꿔줘'
                        : '예: 점심에 손님이 몰려요. 직원 2명이면 될까요?'
                  }
                  disabled={!context || !!busy}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Enter로 보내고, 줄바꿈은 Shift+Enter. 한글 조합 중 Enter는 글자 확정이라 보내지 않는다.
                    // Safari는 확정 Enter를 isComposing=false, keyCode=229로 보내므로 229도 함께 거른다.
                    if (
                      e.key === 'Enter' &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing &&
                      e.nativeEvent.keyCode !== 229
                    ) {
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
                Enter를 누르면 보내져요. 모르는 값은 모른다고 말씀하셔도 돼요.
              </small>
            </div>
          )}
        </section>
        {/* 한 번에 하나씩: 계산한 결과가 생기기 전에는 결과 칸을 보이지 않는다. */}
        {(workspace.result || workspace.saved) && (
          <Results
            feature={feature}
            key={`${context?.current_version_id}:${workspace.result?.result_id}`}
            workspace={workspace}
            onEdit={edit}
            onSaved={onSaved}
          />
        )}
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
    </>
  )
}
