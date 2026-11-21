// 하던 일 목록의 조건 요약 불러오기
import { useEffect, useRef, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import type { SessionSummary } from '../../types/workflow'
import { inputSummary } from './recentFormat'

/**
 * 보이는 업무마다 조건 요약을 불러온다(목록 API에는 조건이 없어서 업무를 하나씩 연다). 실패하면 요약 없이 둔다.
 * "더 보기"로 줄이 늘어도 이미 불러왔거나 불러오는 중인 업무는 다시 부르지 않고 새 업무만 부른다.
 */
export function useInputSummaries(sessions: SessionSummary[]) {
  const [summaries, setSummaries] = useState<Record<number, string>>({})
  const requested = useRef(new Set<number>())
  const mounted = useRef(true)
  const key = sessions.map((s) => s.session_id).join(',')

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const ids = (key ? key.split(',').map(Number) : []).filter((id) => !requested.current.has(id))
    if (!ids.length) return
    ids.forEach((id) => requested.current.add(id))
    void Promise.all(ids.map(async (id) => {
      try {
        const context = await workflowApi.context(id)
        return [id, inputSummary(context.feature_type, context.current_input ?? null)] as const
      } catch {
        return [id, ''] as const
      }
    })).then((rows) => { if (mounted.current) setSummaries((prev) => ({ ...prev, ...Object.fromEntries(rows) })) })
  }, [key])

  return summaries
}
