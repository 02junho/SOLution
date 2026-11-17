import { Icon } from '../../components/common/Ui'

export type ExplanationData = {
  source: 'llm' | 'template'
  explanation: {
    headline: string
    per_choice: { choice_key: string; text: string }[]
    warnings_echo: {
      warning_id: string
      message: string
      requires_ack: boolean
    }[]
    caveats: string[]
  }
}

// Spring 연결 시 부모가 요청 상태와 응답을 전달한다. 이 화면은 서버를 직접 호출하지 않는다.
export type ExplanationState =
  | { status: 'unconnected' | 'idle' }
  | { status: 'loading'; resultId: number }
  | { status: 'error'; resultId: number; message: string }
  | { status: 'ready'; resultId: number; data: ExplanationData }

type Props = {
  resultId: number | null
  eligible: boolean
  busy?: boolean
  state?: ExplanationState
  choiceLabels?: Record<string, string>
  onRequest?: () => void
}

export default function ResultExplanation({
  resultId,
  eligible,
  busy = false,
  state = { status: 'unconnected' },
  choiceLabels = {},
  onRequest,
}: Props) {
  const hasResult = eligible && resultId !== null
  const current: ExplanationState =
    'resultId' in state && state.resultId !== resultId
      ? { status: onRequest ? 'idle' : 'unconnected' }
      : state
  const loading = hasResult && current.status === 'loading'
  const data = hasResult && current.status === 'ready' ? current.data : null
  const error = hasResult && current.status === 'error' ? current.message : null
  const connected = current.status !== 'unconnected' && !!onRequest
  const label = !hasResult
    ? '계산 후 이용'
    : loading
      ? '생성 중'
      : data
        ? data.source === 'llm'
          ? 'AI 설명'
          : '기본 설명'
        : error
          ? '다시 시도'
          : connected
            ? '설명 가능'
            : '연결 준비 중'

  return (
    <section
      className="explanation-card"
      aria-label="AI 결과 설명"
      aria-busy={loading}
    >
      <div className="explanation-heading">
        <div className="section-heading">
          <Icon name="chat" size={18} />
          <h3>AI 결과 설명</h3>
        </div>
        <span className="status-pill">{label}</span>
      </div>
      {!hasResult ? (
        <p className="explanation-hint">
          입력을 확인하고 구매안을 계산하면, 결과에 대한 설명을 확인할 수
          있어요.
        </p>
      ) : loading ? (
        <p className="explanation-loading" role="status">
          <span className="spinner" />
          계산 결과를 바탕으로 설명을 준비하고 있어요.
        </p>
      ) : error ? (
        <p className="explanation-error" role="alert">
          {error}
        </p>
      ) : data ? (
        <div className="explanation-content">
          <p className="explanation-headline">{data.explanation.headline}</p>
          {data.source === 'template' && (
            <p className="explanation-hint">
              계산 결과에 저장된 수치로 만든 기본 설명이에요.
            </p>
          )}
          <dl className="explanation-choices">
            {data.explanation.per_choice.map((item, index) => (
              <div key={item.choice_key}>
                <dt>{choiceLabels[item.choice_key] ?? `대안 ${index + 1}`}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
          {data.explanation.warnings_echo.length > 0 && (
            <div className="explanation-notes">
              <h4>함께 확인할 사항</h4>
              <ul>
                {data.explanation.warnings_echo.map((warning) => (
                  <li key={warning.warning_id}>{warning.message}</li>
                ))}
              </ul>
            </div>
          )}
          {data.explanation.caveats.length > 0 && (
            <ul className="explanation-caveats">
              {data.explanation.caveats.map((text, index) => (
                <li key={index}>{text}</li>
              ))}
            </ul>
          )}
          <p className="explanation-hint">
            설명은 참고용이에요. 확인한 조건과 계산 결과를 기준으로 직접 선택해
            주세요.
          </p>
        </div>
      ) : (
        <p className="explanation-hint">
          {connected
            ? '대안의 차이와 확인할 점을 쉬운 말로 살펴보세요.'
            : '설명 기능 연결을 준비하고 있어요. 연결되면 아래 버튼으로 결과 설명을 불러올 수 있어요.'}
        </p>
      )}
      <button
        type="button"
        className="button secondary explanation-button"
        disabled={!hasResult || !connected || busy || loading}
        onClick={onRequest}
      >
        <Icon name={error || data ? 'refresh' : 'chat'} size={15} />
        {loading
          ? '설명 생성 중…'
          : error
            ? '다시 불러오기'
            : data
              ? '설명 다시 불러오기'
              : '설명 불러오기'}
      </button>
    </section>
  )
}
