// 하던 일 목록의 조건 요약 불러오기
import { useEffect, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import type { SessionSummary } from '../../types/workflow'
import { inputSummary } from './recentFormat'

/** 보이는 업무마다 조건 요약을 불러온다(목록 API에는 조건이 없어서 업무를 하나씩 연다). 실패하면 요약 없이 둔다. */
export function useInputSummaries(sessions: SessionSummary[]) {
  const [summaries, setSummaries] = useState<Record<number, string>>({})
  const key = sessions.map((s) => s.session_id).join(',')
  useEffect(() => {
    let alive = true
    const ids = key ? key.split(',').map(Number) : []
    void Promise.all(ids.map(async (id) => {
      try {
        const context = await workflowApi.context(id)
        return [id, inputSummary(context.feature_type, context.current_input ?? null)] as const
      } catch {
        return [id, ''] as const
      }
    })).then((rows) => { if (alive) setSummaries((prev) => ({ ...prev, ...Object.fromEntries(rows) })) })
    return () => { alive = false }
  }, [key])
  return summaries
}
