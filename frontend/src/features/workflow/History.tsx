import { useCallback, useEffect, useRef, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import { Alert, Empty, Icon, Modal } from '../../components/common/Ui'
import type { FeatureType } from '../../types/api'
import type { Confirmation, Page, SessionSummary } from '../../types/workflow'
import { dateTime, featureName } from './model'
// 운영: 저장한 계획 카드에 고른 운영안 이름 표시
import { CHOICE_TITLE } from '../operation/workspace/format'

type Filter = FeatureType | 'all'
function Filters({
  value,
  onChange,
}: {
  value: Filter
  onChange: (value: Filter) => void
}) {
  return (
    <div className="filter-tabs" role="group" aria-label="업무 종류 필터">
      {(['all', 'purchase', 'operation'] as const).map((type) => (
        <button
          type="button"
          key={type}
          aria-pressed={value === type}
          className={value === type ? 'active' : ''}
          onClick={() => onChange(type)}
        >
          {type === 'all' ? '전체' : featureName(type)}
        </button>
      ))}
    </div>
  )
}
function useHistory<T>(
  fetcher: (
    filter: FeatureType | undefined,
    cursor: string | null,
  ) => Promise<Page<T>>,
) {
  const [filter, setFilter] = useState<Filter>('all')
  const [items, setItems] = useState<T[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const generation = useRef(0)
  const busy = useRef(false)
  const removed = useRef<((item: T) => boolean)[]>([])
  const read = useCallback(
    async (cursor: string | null, token: number) => {
      busy.current = true
      try {
        const page = await fetcher(
          filter === 'all' ? undefined : filter,
          cursor,
        )
        if (token === generation.current) {
          setItems((previous) =>
            (cursor ? [...previous, ...page.items] : page.items)
              .filter((item) => !removed.current.some((matches) => matches(item))),
          )
          setNext(page.next_cursor)
        }
      } catch (cause) {
        if (token === generation.current)
          setError(
            cause instanceof Error
              ? cause.message
              : '기록을 불러오지 못했어요.',
          )
      } finally {
        if (token === generation.current) {
          busy.current = false
          setLoading(false)
        }
      }
    },
    [fetcher, filter],
  )
  useEffect(() => {
    const token = ++generation.current
    busy.current = true
    fetcher(filter === 'all' ? undefined : filter, null)
      .then((page) => {
        if (token === generation.current) {
          setItems(page.items.filter((item) => !removed.current.some((matches) => matches(item))))
          setNext(page.next_cursor)
        }
      })
      .catch((cause) => {
        if (token === generation.current)
          setError(
            cause instanceof Error
              ? cause.message
              : '기록을 불러오지 못했어요.',
          )
      })
      .finally(() => {
        if (token === generation.current) {
          busy.current = false
          setLoading(false)
        }
      })
    return () => {
      generation.current = token + 1
    }
  }, [fetcher, filter])
  return {
    items,
    next,
    loading,
    error,
    filter,
    setFilter: (nextFilter: Filter) => {
      if (nextFilter === filter) return
      setLoading(true)
      setError('')
      setItems([])
      setNext(null)
      setFilter(nextFilter)
    },
    more: () => {
      if (!busy.current && next) {
        setLoading(true)
        setError('')
        void read(next, generation.current)
      }
    },
    remove: (matches: (item: T) => boolean) => {
      removed.current.push(matches)
      setItems((previous) => previous.filter((item) => !matches(item)))
    },
    retry: () => {
      if (!busy.current) {
        setLoading(true)
        setError('')
        void read(null, generation.current)
      }
    },
  }
}
export function SessionHistory({
  onClose,
  onSelect,
  onDeleted,
}: {
  onClose: () => void
  onSelect: (id: number) => void
  onDeleted?: (id: number) => void
}) {
  const history = useHistory<SessionSummary>(workflowApi.sessions)
  const [deleting, setDeleting] = useState<number | null>(null)
  const [target, setTarget] = useState<SessionSummary | null>(null)
  const [deleteError, setDeleteError] = useState('')
  const deletionLock = useRef(false)
  async function remove() {
    if (!target || deletionLock.current) return
    deletionLock.current = true
    setDeleting(target.session_id)
    setDeleteError('')
    try {
      await workflowApi.deleteSession(target.session_id)
      history.remove((item) => item.session_id === target.session_id)
      onDeleted?.(target.session_id)
      setTarget(null)
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : '업무를 삭제하지 못했어요.')
    } finally {
      deletionLock.current = false
      setDeleting(null)
    }
  }
  return (
    <Modal
      title="하던 업무 이어하기"
      description="대화와 조건은 업무별로 저장돼 있어요."
      onClose={() => { if (deleting === null) onClose() }}
      wide
    >
      <Filters value={history.filter} onChange={history.setFilter} />
      {history.error && (
        <Alert error>
          {history.error}
          <button className="text-button" onClick={history.retry}>
            다시 불러오기
          </button>
        </Alert>
      )}
      {!history.loading && !history.error && !history.items.length && (
        <Empty title="아직 저장된 업무가 없어요">
          <p>새 업무를 시작하면 이곳에서 이어 할 수 있어요.</p>
        </Empty>
      )}
      {target && (
        <section className="delete-confirm" aria-label="업무 삭제 확인">
          <strong>‘{target.title}’ 업무를 삭제할까요?</strong>
          <p>이어하기 목록과 업무 대화를 더 이상 열 수 없어요. 확정한 계획과 계산 근거는 유지돼요.</p>
          {deleteError && <Alert error>{deleteError}</Alert>}
          <button className="button secondary" disabled={deleting !== null} onClick={() => setTarget(null)}>취소</button>
          <button className="button primary" disabled={deleting !== null} onClick={() => void remove()}>
            {deleting !== null ? '삭제 중…' : '업무 삭제'}
          </button>
        </section>
      )}
      <div className="history-list">
        {history.items.map((session) => (
          <div className="history-entry" key={session.session_id}>
            <button
              className="history-row"
              disabled={deleting !== null}
              onClick={() => onSelect(session.session_id)}
            >
              <span className="history-icon">
                <Icon
                  name={session.feature_type === 'purchase' ? 'box' : 'clock'}
                />
              </span>
              <span>
                <strong>{session.title}</strong>
                <small>
                  {featureName(session.feature_type)} · 입력{' '}
                  {session.current_version} · {dateTime(session.updated_at)}
                </small>
              </span>
              <span className="status-pill">
                {(
                  {
                    input: '입력 중',
                    review: '검토 중',
                    result: '결과 확인',
                    saved: '저장 완료',
                    running: '계산 중',
                  } as Record<string, string>
                )[session.step] ?? '진행 중'}
              </span>
              <Icon name="chevron" size={16} />
            </button>
            <button type="button" className="text-button delete-action" disabled={deleting !== null}
              aria-label={`${session.title} 업무 삭제`} onClick={() => { setTarget(session); setDeleteError('') }}>
              업무 삭제
            </button>
          </div>
        ))}
      </div>
      {history.loading && (
        <p className="loading" role="status">
          업무를 불러오고 있어요…
        </p>
      )}
      {history.next && (
        <button
          className="button secondary load-more"
          onClick={history.more}
          disabled={history.loading}
        >
          업무 더 보기
        </button>
      )}
    </Modal>
  )
}
export function ConfirmationHistory({
  onOpen,
}: {
  onOpen: (id: number) => void
}) {
  const history = useHistory<Confirmation>(workflowApi.confirmations)
  return (
    <section className="history-page">
      <div className="page-title">
        <div>
          <p className="eyebrow">SAVED PLANS</p>
          <h1>저장한 계획</h1>
          <p>사장님이 직접 확인하고 선택한 계획을 모았어요.</p>
        </div>
        <span className="history-emblem">
          <Icon name="book" size={28} />
        </span>
      </div>
      <Filters value={history.filter} onChange={history.setFilter} />
      {history.error && (
        <Alert error>
          {history.error}
          <button className="text-button" onClick={history.retry}>
            다시 불러오기
          </button>
        </Alert>
      )}
      {!history.loading && !history.error && !history.items.length && (
        <Empty title="아직 확정한 계획이 없어요">
          <p>업무 공간에서 결과를 비교하고 계획을 저장해 보세요.</p>
          <a href="#/work" className="button primary">
            업무 공간으로 <Icon name="arrow" size={16} />
          </a>
        </Empty>
      )}
      <div className="confirmation-grid">
        {history.items.map((confirmation) => (
          <button
            className="confirmation-card"
            key={confirmation.confirmation_id}
            onClick={() => onOpen(confirmation.confirmation_id)}
          >
            <div className="choice-top">
              <span className="eyebrow">
                {featureName(confirmation.feature_type)}
              </span>
              <span
                className={`status-pill ${confirmation.is_current_version ? 'green' : ''}`}
              >
                {confirmation.is_current_version ? '현재 조건' : '과거 기록'}
              </span>
            </div>
            <h2>
              {confirmation.feature_type === 'purchase'
                ? '저장한 구매 계획'
                : `운영 계획 · ${CHOICE_TITLE[confirmation.selected_choice_key] ?? '저장한 안'}`}
            </h2>
            <p>
              입력 {confirmation.version_no} ·{' '}
              {dateTime(confirmation.confirmed_at)}
            </p>
            <div className="confirmation-card-footer">
              <span>보존된 내용 확인</span>
              <Icon name="arrow" size={18} />
            </div>
          </button>
        ))}
      </div>
      {history.loading && (
        <p className="loading" role="status">
          저장한 계획을 불러오고 있어요…
        </p>
      )}
      {history.next && (
        <button
          className="button secondary load-more"
          onClick={history.more}
          disabled={history.loading}
        >
          계획 더 보기
        </button>
      )}
    </section>
  )
}
