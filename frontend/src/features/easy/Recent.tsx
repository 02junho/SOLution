// 쉬운 화면 첫 화면 아래: 최근 업무(이어서 보기)와 최근 저장한 계획. 서버에 있는 실제 기록이다.
// 누르면 쉬운 화면 안에서 연다(#/work/…, #/plans/…).
import { useEffect, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import type { Confirmation, SessionSummary } from '../../types/workflow'
import { CHOICE, FEATURE, STEP, cleanTitle, when } from './recentFormat'
import { useInputSummaries } from './useInputSummaries'

export default function Recent() {
  const [sessions, setSessions] = useState<SessionSummary[] | null>(null)
  const [plans, setPlans] = useState<Confirmation[] | null>(null)
  const summaries = useInputSummaries(sessions ?? [])

  useEffect(() => {
    let alive = true
    workflowApi.sessions(undefined, null).then((page) => { if (alive) setSessions(page.items.slice(0, 4)) }).catch(() => { if (alive) setSessions([]) })
    workflowApi.confirmations(undefined, null).then((page) => { if (alive) setPlans(page.items.slice(0, 4)) }).catch(() => { if (alive) setPlans([]) })
    return () => { alive = false }
  }, [])

  return (
    <div className="easy-recent">
      <section className="easy-recent-card">
        <div className="easy-recent-head">
          <h2>최근 업무</h2>
          <a className="easy-text-button" href="#/work">전체 보기</a>
        </div>
        {sessions === null ? <p className="easy-empty">불러오는 중이에요</p>
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
        {plans === null ? <p className="easy-empty">불러오는 중이에요</p>
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
