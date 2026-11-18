import { useEffect, useRef, useState } from 'react'
import { PreparationApiError } from '../api/purchasePreparationApi'
import type { PreparationApi } from '../api/purchasePreparationApi'
import type { Snapshot } from '../types/purchasePreparation'

export function usePurchasePreparation(id: string, api: PreparationApi) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const generation = useRef(0)
  const locked = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    const target = ++generation.current
    locked.current = true
    setBusy(true)
    setError('')
    setSnapshot(null)
    api.get(id, controller.signal).then(data => {
      if (generation.current === target) setSnapshot(data)
    }).catch(error => {
      if (generation.current === target) setError(error instanceof Error ? error.message : '조회에 실패했습니다.')
    }).finally(() => {
      if (generation.current === target) { locked.current = false; setBusy(false) }
    })
    return () => { generation.current++; controller.abort() }
  }, [api, id, reload])

  async function update(run: (version: number) => Promise<Snapshot>) {
    if (!snapshot || locked.current) return false
    const target = generation.current
    locked.current = true
    setBusy(true)
    setError('')
    try {
      const result = await run(snapshot.version)
      if (generation.current !== target) return false
      setSnapshot(result)
      return true
    } catch (err) {
      if (generation.current !== target) return false
      if (err instanceof PreparationApiError && err.status === 409) {
        try {
          const latest = await api.get(id)
          if (generation.current !== target) return false
          setSnapshot(latest)
          setError('다른 변경 사항을 불러왔습니다. 내용을 확인한 뒤 다시 시도해 주세요.')
        } catch {
          if (generation.current === target) setError('최신 상태를 불러오지 못했습니다. 화면을 새로 조회해 주세요.')
        }
      } else setError(err instanceof Error ? err.message : '요청에 실패했습니다.')
      return false
    } finally {
      if (generation.current === target) { locked.current = false; setBusy(false) }
    }
  }

  return { snapshot, busy, error, update, retry: () => setReload(x => x + 1) }
}
