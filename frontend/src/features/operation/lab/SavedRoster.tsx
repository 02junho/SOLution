import { useEffect, useState } from 'react'
import { loadRosterResult } from '../../../api/operationApi'
import { workflowApi } from '../../../api/workflowApi'
import { WEEKDAYS } from '../workspace/storeFile'
import { optionsFromStored } from './rosterTypes'
import type { OptionKey, RosterOptions, StoredRosterResult } from './rosterTypes'
import { resultHash, rememberHash, waitRoster } from './rosterJob'
import type { PendingRoster as Pending } from './rosterJob'
import { OptionsView } from './WeeklyCard'

/**
 * 저장한 추천 근무표 다시 보기(#/lab?result=결과번호). 저장된 상세로 같은 화면을 다시 그린다.
 * 아직 고르지 않았고 최신 입력이면 여기서도 골라 저장할 수 있다.
 */
export default function SavedRoster({ resultId }: { resultId: number }) {
  const [stored, setStored] = useState<StoredRosterResult | null>(null)
  const [data, setData] = useState<RosterOptions | null>(null)
  const [chosen, setChosen] = useState<OptionKey>('RECOMMENDED')
  const [confirmed, setConfirmed] = useState<OptionKey | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let alive = true
    void loadRosterResult(resultId).then((response) => {
      if (!alive) return
      if (response.status !== 'ok' || !response.data || response.data.summary?.result_kind !== 'ROSTER_OPTIONS') {
        setError(response.message ?? '저장한 추천 근무표를 찾지 못했어요.')
        return
      }
      setStored(response.data)
      setData(optionsFromStored(response.data))
      setConfirmed(response.data.confirmed_choice_key ?? null)
      setChosen(response.data.confirmed_choice_key ?? response.data.summary.recommended_choice_key)
    })
    return () => {
      alive = false
    }
  }, [resultId])

  async function confirm(key: OptionKey) {
    if (!stored) return
    setBusy(true)
    setError('')
    try {
      const warnings = stored.summary.warnings
        .filter((w) => w.choice_keys === null || w.choice_keys.includes(key))
        .map((w) => w.warning_id)
      await workflowApi.confirm(stored.result_id, stored.input_version_id, key, warnings, crypto.randomUUID())
      setConfirmed(key)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '저장하지 못했어요.')
    } finally {
      setBusy(false)
    }
  }

  const shown = data ? WEEKDAYS.filter((d) => d in data.days) : []
  return (
    <div className="lab-page">
      <header className="lab-head">
        <a href="#/lab">← 실험실</a>
        <h1>저장한 추천 근무표 · 결과 {resultId}</h1>
      </header>
      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}
      {!data && !error && <p className="lab-status">불러오는 중…</p>}
      {stored && data && (
        <section className="lab-card">
          <OptionsView
            data={data}
            shown={shown}
            chosen={chosen}
            onChoose={setChosen}
            save={{ summary: stored.summary, confirmed, busy, onConfirm: (key) => void confirm(key) }}
          />
        </section>
      )}
    </div>
  )
}

/**
 * 계산 중이던 근무표 이어 보기(#/lab?session=…&version=…&key=…). 끝났는지 확인하고, 끝나면 저장한 근무표 화면으로.
 * 화면을 나갔다가 돌아와도 서버 계산은 계속된다.
 */
export function PendingRoster({ pending }: { pending: Pending }) {
  const [resultId, setResultId] = useState<number | null>(null)
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')

  // 부모가 다시 그려질 때마다 새 객체가 와도 같은 계산이면 다시 시작하지 않게 값으로 비교한다.
  const { sessionId, versionId, key } = pending
  useEffect(() => {
    const signal = { stopped: false }
    waitRoster({ sessionId, versionId, key }, setSeconds, signal)
      .then((job) => {
        if (!job?.result_id) return
        rememberHash(resultHash(job.result_id))
        setResultId(job.result_id)
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : '추천 근무표를 만들지 못했어요.'))
    return () => {
      signal.stopped = true
    }
  }, [sessionId, versionId, key])

  if (resultId) return <SavedRoster resultId={resultId} />
  return (
    <div className="lab-page">
      <header className="lab-head">
        <a href="#/lab">← 실험실</a>
        <h1>추천 근무표 이어 보기</h1>
      </header>
      {error ? (
        <p className="lab-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="lab-status" role="status">
          아직 만드는 중이에요({seconds}초째 확인 중). 다 되면 바로 보여 드릴게요…
        </p>
      )}
    </div>
  )
}
