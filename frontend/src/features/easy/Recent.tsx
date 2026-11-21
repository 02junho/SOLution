// 쉬운 화면 첫 화면 아래: 최근 업무(이어서 보기)와 최근 저장한 계획. 서버에 있는 실제 기록이다.
// 누르면 쉬운 화면 안에서 연다(#/work/…, #/plans/…).
import { useEffect, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import type { Confirmation, SessionSummary } from '../../types/workflow'
import { CHOICE, FEATURE, STEP, cleanTitle, when } from './recentFormat'
import { useInputSummaries } from './useInputSummaries'

type Fetch<T> = () => Promise<{ items: T[] }>
const fetchSessions: Fetch<SessionSummary> = () => workflowApi.sessions(undefined, null)
const fetchPlans: Fetch<Confirmation> = () => workflowApi.confirmations(undefined, null)

/** 최근 4개. 불러오지 못하면 "기록 없음"이 아니라 실패로 알리고, 다시 불러올 수 있게 한다. */
function useRecent<T>(load: Fetch<T>) {
  const [items, setItems] = useState<T[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    load().then((page) => { if (alive) { setItems(page.items.slice(0, 4)); setFailed(false) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [load, attempt])
  const retry = () => { setFailed(false); setItems(null); setAttempt((n) => n + 1) }
  return { items, failed, retry }
}

function Failed({ onRetry }: { onRetry: () => void }) {
  return (
    <p className="easy-empty" role="status">
      불러오지 못했어요. <button type="button" className="easy-text-button" onClick={onRetry}>다시 불러오기</button>
    </p>
  )
}

export default function Recent() {
  const { items: sessions, failed: sessionsFailed, retry: retrySessions } = useRecent(fetchSessions)
  const { items: plans, failed: plansFailed, retry: retryPlans } = useRecent(fetchPlans)
  const summaries = useInputSummaries(sessions ?? [])

  return (
    <div className="easy-recent">
      <section className="easy-recent-card">
        <div className="easy-recent-head">
          <h2>최근 업무</h2>
          <a className="easy-text-button" href="#/work">전체 보기</a>
        </div>
        {sessionsFailed ? <Failed onRetry={retrySessions} />
          : sessions === null ? <p className="easy-empty">불러오는 중이에요</p>
          : sessions.length === 0 ? <p className="easy-empty">아직 한 업무가 없어요</p>
            : (
              <ul>
                {sessions.map((s) => (
                  <li key={s.session_id}>
                    <a href={`#/work/${s.session_id}`}>
                      <span className={`easy-tag ${s.feature_type}`}>{FEATURE[s.feature_type] ?? s.feature_type}</span>
                      <b>{cleanTitle(s.title)}</b>
                      <small>{summaries[s.session_id] ? `${summaries[s.session_id]} · ` : ''}{STEP[s.step] ?? s.step} · {when(s.updated_at)}</small>
                    </a>
                  </li>
                ))}
              </ul>
            )}
      </section>
      <section className="easy-recent-card">
        <div className="easy-recent-head">
          <h2>저장한 계획</h2>
          <a className="easy-text-button" href="#/plans">전체 보기</a>
        </div>
        {plansFailed ? <Failed onRetry={retryPlans} />
          : plans === null ? <p className="easy-empty">불러오는 중이에요</p>
          : plans.length === 0 ? <p className="easy-empty">아직 저장한 계획이 없어요</p>
            : (
              <ul>
                {plans.map((p) => (
                  <li key={p.confirmation_id}>
                    <a href={`#/plans/${p.confirmation_id}`}>
                      <span className={`easy-tag ${p.feature_type}`}>{FEATURE[p.feature_type] ?? p.feature_type}</span>
                      <b>{CHOICE[p.selected_choice_key] ?? p.selected_choice_key}</b>
                      <small>{when(p.confirmed_at)}에 저장</small>
                    </a>
                  </li>
                ))}
              </ul>
            )}
      </section>
    </div>
  )
}
