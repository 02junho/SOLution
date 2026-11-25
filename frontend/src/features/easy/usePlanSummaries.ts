// 저장한 근무표만 요약한다. 현재 업무가 아닌 확정이 가리키는 결과의 계산 요청을 읽는다.
import { useEffect, useRef, useState } from 'react'
import { workflowApi } from '../../api/workflowApi'
import { loadRosterResult } from '../../api/operationApi'
import type { Confirmation } from '../../types/workflow'
import { OPTION_NAME } from '../operation/easy/rosterNames'
import { rosterPlanSummary } from './recentFormat'

async function loadSummary(id: number): Promise<string> {
  try {
    const plan = await workflowApi.confirmation(id)
    const response = await loadRosterResult(plan.result_id)
    const data = response.data
    if (response.status !== 'ok' || !data || data.result_id !== plan.result_id ||
        data.input_version_id !== plan.input_version_id || data.summary?.result_kind !== 'ROSTER_OPTIONS') return ''
    return rosterPlanSummary(data.detail?.request)
  } catch {
    // 요약만 실패한 경우 저장 목록 및 상세 열기에는 영향이 없게 한다.
    return ''
  }
}

export function usePlanSummaries(plans: Confirmation[]) {
  const [summaries, setSummaries] = useState<Record<number, string>>({})
  const requested = useRef(new Map<number, Promise<string>>())
  const key = plans.filter((p) => p.feature_type === 'operation' &&
    Object.hasOwn(OPTION_NAME, p.selected_choice_key)).map((p) => p.confirmation_id).join(',')

  useEffect(() => {
    let active = true
    const ids = key ? key.split(',').map(Number) : []
    async function load() {
      // 전체 보기(20건씩)도 동시에 상세 요청을 몰아 보내지 않는다.
      for (let i = 0; active && i < ids.length; i += 4) {
        const rows = await Promise.all(ids.slice(i, i + 4).map(async (id) => {
          let pending = requested.current.get(id)
          if (!pending) {
            pending = loadSummary(id)
            requested.current.set(id, pending)
          }
          return [id, await pending] as const
        }))
        if (active) setSummaries((prev) => ({ ...prev, ...Object.fromEntries(rows) }))
      }
    }
    void load()
    return () => { active = false }
  }, [key])

  return summaries
}
