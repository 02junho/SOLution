// 쉬운 화면 안의 목록: 하던 일(#/work)과 저장한 계획(#/plans). 누르면 쉬운 화면 안에서 연다.
import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { workflowApi } from '../../api/workflowApi'
import type { Confirmation, SessionSummary } from '../../types/workflow'
import { CHOICE, STEP, cleanTitle, featureTag, when } from './recentFormat'
import { useInputSummaries } from './useInputSummaries'
import { forgetSaves } from './saveKey'
import { ROSTER_MODE } from '../operation/easy/rosterSwitch'

const EASY_FEATURES = new Set(['purchase', 'operation'])


type Loaded<T> = { items: T[]; cursor: string | null; error: string }

type Fetch<T> = (cursor: string | null) => Promise<{ items: T[]; next_cursor: string | null }>
const fetchSessions: Fetch<SessionSummary> = (cursor) => workflowApi.sessions(undefined, cursor)
const fetchPlans: Fetch<Confirmation> = (cursor) => workflowApi.confirmations(undefined, cursor)

function useCursorList<T>(load: Fetch<T>) {
  const [list, setList] = useState<Loaded<T> | null>(null)
  const [busy, setBusy] = useState(false)
  // 첫 불러오기 실패: 빈 목록과 구분해 알리고 "다시 불러오기"로 처음부터 다시 부른다.
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    let alive = true
    load(null)
      .then((page) => { if (alive) { setList({ items: page.items, cursor: page.next_cursor, error: '' }); setFailed(false) } })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [load, attempt])
  const retry = () => { setFailed(false); setList(null); setAttempt((n) => n + 1) }
  async function more() {
    if (!list?.cursor) return
    const cursor = list.cursor
    setBusy(true)
    try {
      const page = await load(cursor)
      // 불러오는 사이 지운 줄이 되살아나지 않게 그때그때의 최신 목록(prev)에 붙인다.
      setList((prev) => (prev ? { items: [...prev.items, ...page.items], cursor: page.next_cursor, error: '' } : prev))
    } catch {
      setList((prev) => (prev ? { ...prev, error: '더 불러오지 못했어요. 다시 눌러 주세요.' } : prev))
    } finally {
      setBusy(false)
    }
  }
  /** 지운 줄을 목록에서 뺀다(다시 불러오지 않고) */
  function remove(keep: (item: T) => boolean) {
    setList((prev) => (prev ? { ...prev, items: prev.items.filter(keep) } : prev))
  }
  return { list, busy, more, remove, failed, retry }
}

/** 줄마다 "지우기". 누르면 그 줄 아래에서 한 번 더 묻는다(실수로 지우지 않게). */
function DeleteRow({ name, warn, onDelete }: { name: string; warn: string; onDelete: () => Promise<void> }) {
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!asking) {
    return <button type="button" className="easy-row-delete" aria-label={`${name} 지우기`} onClick={() => setAsking(true)}>지우기</button>
  }
  return (
    <div className="easy-row-confirm" role="group" aria-label={`${name} 지울까요`}>
      <p>{warn}</p>
      {error && <p className="easy-error">{error}</p>}
      <div className="easy-actions">
        <button type="button" className="easy-danger" disabled={busy} onClick={async () => {
          setBusy(true); setError('')
          try { await onDelete() } catch (cause) { setError(cause instanceof Error ? cause.message : '지우지 못했어요. 다시 눌러 주세요.'); setBusy(false) }
        }}>{busy ? '지우는 중…' : '지우기'}</button>
        <button type="button" className="easy-secondary" disabled={busy} onClick={() => { setAsking(false); setError('') }}>취소</button>
      </div>
    </div>
  )
}

function LoadFailed({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="easy-empty" role="status">
      <p>목록을 불러오지 못했어요.</p>
      <button type="button" className="easy-secondary" onClick={onRetry}>다시 불러오기</button>
    </div>
  )
}

function Shell({ title, back, children, footer }: { title: string; back?: boolean; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="easy-card easy-list">
      {back !== false && <a className="easy-back" href="#/">← 홈으로</a>}
      <h1>{title}</h1>
      {children}
      {footer}
    </section>
  )
}

export function SessionList() {
  const { list, busy, more, remove, failed, retry } = useCursorList(fetchSessions)
  const items = (list?.items ?? []).filter((s) => EASY_FEATURES.has(s.feature_type))
  const summaries = useInputSummaries(items)
  return (
    <Shell
      title="하던 일 이어하기"
      footer={list?.cursor ? <button type="button" className="easy-secondary easy-more" disabled={busy} onClick={() => void more()}>{busy ? '불러오는 중…' : '더 보기'}</button> : null}
    >
      <p className="easy-list-sub">누르면 멈춘 곳부터 이어서 해요. 결과가 나온 일은 결과를 바로 보여 드려요.</p>
      {failed ? <LoadFailed onRetry={retry} />
        : list === null ? <p className="easy-empty">불러오는 중이에요</p>
        : items.length === 0 ? <p className="easy-empty">{list.error || '아직 한 업무가 없어요'}</p>
          : (
            <ul className="easy-list-items">
              {items.map((s: SessionSummary) => (
                <li key={s.session_id}>
                  <a href={`#/work/${s.session_id}`}>
                    <span className={`easy-tag ${s.feature_type}`}>{featureTag(s.feature_type, { title: s.title })}</span>
                    <b>{cleanTitle(s.title)}{summaries[s.session_id] && <span className="easy-list-sum"> · {summaries[s.session_id]}</span>}</b>
                    <small>{STEP[s.step] ?? s.step} · {when(s.updated_at)}</small>
                    <span className="easy-list-go" aria-hidden>›</span>
                  </a>
                  <DeleteRow
                    name={cleanTitle(s.title)}
                    warn={s.step === 'saved'
                      ? '이 업무를 지울까요? 하던 일 목록에서 사라져요. 저장한 계획은 "저장한 계획"에 그대로 남아요.'
                      : '이 업무를 지울까요? 하던 일 목록에서 사라지고 다시 열 수 없어요.'}
                    onDelete={async () => { await workflowApi.deleteSession(s.session_id); remove((x) => x.session_id !== s.session_id) }}
                  />
                </li>
              ))}
            </ul>
          )}
      {list?.error && items.length > 0 && <p className="easy-error">{list.error}</p>}
    </Shell>
  )
}

export function PlanList() {
  const { list, busy, more, remove, failed, retry } = useCursorList(fetchPlans)
  const items = (list?.items ?? []).filter((p) => EASY_FEATURES.has(p.feature_type))
  return (
    <Shell
      title="저장한 계획"
      footer={list?.cursor ? <button type="button" className="easy-secondary easy-more" disabled={busy} onClick={() => void more()}>{busy ? '불러오는 중…' : '더 보기'}</button> : null}
    >
      <p className="easy-list-sub">사장님이 저장한 구매안과 {ROSTER_MODE ? '근무표' : '배치표'}예요. 누르면 그때 결과를 다시 보여 드려요.</p>
      {failed ? <LoadFailed onRetry={retry} />
        : list === null ? <p className="easy-empty">불러오는 중이에요</p>
        : items.length === 0 ? <p className="easy-empty">{list.error || '아직 저장한 계획이 없어요'}</p>
          : (
            <ul className="easy-list-items">
              {items.map((p: Confirmation) => (
                <li key={p.confirmation_id}>
                  <a href={`#/plans/${p.confirmation_id}`}>
                    <span className={`easy-tag ${p.feature_type}`}>{featureTag(p.feature_type, { choiceKey: p.selected_choice_key })}</span>
                    <b>{CHOICE[p.selected_choice_key] ?? p.selected_choice_key}</b>
                    <small>{when(p.confirmed_at)}에 저장{p.is_current_version ? '' : ' · 이후 조건이 바뀜'}</small>
                    <span className="easy-list-go" aria-hidden>›</span>
                  </a>
                  <DeleteRow
                    name={CHOICE[p.selected_choice_key] ?? p.selected_choice_key}
                    warn="저장한 계획을 지울까요? 지우면 되돌릴 수 없어요. 업무는 하던 일 목록에 그대로 남아요."
                    onDelete={async () => {
                      const deleted = await workflowApi.deleteConfirmation(p.confirmation_id)
                      // 지운 계획의 저장 키를 버려, 같은 결과를 다시 저장하면 새로 저장되게 한다.
                      if (typeof deleted.result_id === 'number') forgetSaves(deleted.result_id)
                      remove((x) => x.confirmation_id !== p.confirmation_id)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
      {list?.error && items.length > 0 && <p className="easy-error">{list.error}</p>}
    </Shell>
  )
}
