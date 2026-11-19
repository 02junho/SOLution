import { useRef, useState } from 'react'
import { workflowApi, WorkflowError } from '../../api/workflowApi'
import { Alert } from '../../components/common/Ui'

export default function DeleteConfirmation({ id, onDeleted }: { id: number; onDeleted: (id: number) => void }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const locked = useRef(false)
  async function remove() {
    if (locked.current) return
    locked.current = true
    setBusy(true)
    setError('')
    try {
      await workflowApi.deleteConfirmation(id)
      onDeleted(id)
    } catch (cause) {
      if (cause instanceof WorkflowError && cause.code === 'CONFIRMATION_NOT_FOUND') {
        onDeleted(id)
        return
      }
      setError(cause instanceof Error ? cause.message : '계획을 삭제하지 못했어요.')
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  return (
    <div className="plan-delete">
      {!confirming ? (
        <button type="button" className="text-button delete-action" aria-label={`저장 번호 ${id} 계획 삭제`}
          onClick={() => setConfirming(true)}>계획 삭제</button>
      ) : (
        <section className="delete-confirm" aria-label="저장한 계획 삭제 확인">
          <strong>이 저장한 계획을 삭제할까요?</strong>
          <p>이 계획의 저장 기록이 삭제돼요. 업무 대화와 계산 결과는 그대로 남아요.</p>
          {error && <Alert error>{error}</Alert>}
          <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>취소</button>
          <button type="button" className="button primary" disabled={busy} onClick={() => void remove()}>
            {busy ? '삭제 중…' : '계획 삭제'}
          </button>
        </section>
      )}
    </div>
  )
}
