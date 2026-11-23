// 결과를 쉬운 말로 설명 듣기. Spring이 저장된 결과를 읽어 AI(/agent/explain)에 설명을 맡긴다.
// AI가 안 되면 서버가 저장된 수치로 만든 기본 설명을 준다. 설명은 저장하지 않고, 숫자는 계산 결과만 쓴다.
import { useEffect, useRef, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import type { ExplanationData } from '../workflow/ResultExplanation'
import { CHOICE } from './recentFormat'

type State =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: ExplanationData }

export default function Explain({ resultId }: { resultId: number }) {
  // 결과가 바뀌면 부모가 key로 새로 그린다(이전 설명이 남지 않게). 닫힌 뒤 늦게 온 응답은 버린다.
  const [state, setState] = useState<State>({ status: 'idle' })
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  async function load() {
    setState({ status: 'loading' })
    try {
      const data = await workflowApi.explain<ExplanationData>(resultId)
      if (alive.current) setState({ status: 'ready', data })
    } catch (cause) {
      if (alive.current) setState({ status: 'error', message: cause instanceof Error ? cause.message : '설명을 불러오지 못했어요.' })
    }
  }

  return (
    <section className="easy-card easy-explain" aria-label="쉬운 말 설명" aria-busy={state.status === 'loading'} data-tour="explain">
      <div className="easy-explain-head">
        <h2>이 결과, 쉬운 말로 들어 보기</h2>
        {state.status === 'ready' && <span className="easy-label">{state.data.source === 'llm' ? 'AI 설명' : '기본 설명'}</span>}
      </div>
      {state.status === 'idle' && (
        <>
          <p className="easy-muted">안마다 무엇이 다른지, 무엇을 확인해야 하는지 말로 풀어 드려요.</p>
          <button type="button" className="easy-secondary" onClick={() => void load()}>설명 듣기</button>
        </>
      )}
      {state.status === 'loading' && (
        <p className="easy-running" role="status"><span className="easy-spinner" aria-hidden />계산 결과를 읽고 설명을 쓰는 중이에요</p>
      )}
      {state.status === 'error' && (
        <>
          <p role="alert">{state.message}</p>
          <button type="button" className="easy-secondary" onClick={() => void load()}>다시 불러오기</button>
        </>
      )}
      {state.status === 'ready' && (
        <div className="easy-explain-body">
          <p className="easy-explain-headline">{state.data.explanation.headline}</p>
          <dl>
            {state.data.explanation.per_choice.map((item, index) => (
              <div key={item.choice_key}>
                <dt>{CHOICE[item.choice_key] ?? `${index + 1}안`}</dt>
                <dd>{item.text}</dd>
              </div>
            ))}
          </dl>
          {state.data.explanation.warnings_echo.length > 0 && (
            <>
              <h3>함께 확인할 점</h3>
              <ul>{state.data.explanation.warnings_echo.map((warning) => <li key={warning.warning_id}>{warning.message}</li>)}</ul>
            </>
          )}
          {state.data.explanation.caveats.length > 0 && (
            <ul className="easy-muted">{state.data.explanation.caveats.map((text, index) => <li key={index}>{text}</li>)}</ul>
          )}
          <p className="easy-muted">
            {state.data.source === 'template' ? '지금은 계산 결과 숫자로 만든 기본 설명이에요. ' : ''}
            설명은 참고용이에요. 숫자는 계산 결과 그대로이고, 고르는 건 사장님이에요.
          </p>
        </div>
      )}
    </section>
  )
}
