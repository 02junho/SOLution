import { useState, useRef, useEffect } from 'react'
import type { FormEvent } from 'react'
import { purchasePreparationApi } from '../api/purchasePreparationApi'
import type { PreparationApi } from '../api/purchasePreparationApi'
import { MaterialsTable, QuotesTable, SalesTable } from '../features/purchase-preparation/Tables'
import { usePurchasePreparation } from '../hooks/usePurchasePreparation'
import type { Answer, Question } from '../types/purchasePreparation'
import '../features/purchase-preparation/styles.css'

const stages = [
  { label: '입력', keys: ['INPUT'] }, { label: '확인', keys: ['REVIEW', 'RUNNING'] },
  { label: '구매안', keys: ['OPTIMIZATION', 'OPTIMIZE', 'RESULT'] },
  { label: '확정', keys: ['CONFIRMED', 'SAVED'] },
]
const statusLabel: Record<string, string> = {
  NEEDS_REVIEW: '견적 확인 필요', COMPLETE: '완료', BLOCKED: '계산 대기',
  PENDING: '대기', READY: '계산 가능', NEEDS_INPUT: '입력 필요', OK: '완료',
}
function AnswerControls({ q, busy, answer }: { q: Question; busy: boolean; answer: (a: Answer) => void }) {
  const [text, setText] = useState('')
  if (q.options?.length) return <div className="pp-options" aria-label="질문 답변">
    {q.options.map(o => <button className="pp-plain" key={o.value} disabled={busy}
      onClick={() => answer({ type: 'OPTION', value: o.value })}>{o.label}</button>)}
  </div>
  return <form className="pp-options" onSubmit={e => {
    e.preventDefault()
    if (text.trim()) answer({ type: 'TEXT', text: text.trim() })
  }}>
    <input aria-label="질문에 대한 답변" value={text} onChange={e => setText(e.target.value)} />
    <button className="pp-plain" disabled={busy || !text.trim()}>답변 보내기</button>
  </form>
}

export default function PurchasePreparationPage({ preparationId, api = purchasePreparationApi }: {
  preparationId: string; api?: PreparationApi
}) {
  const { snapshot: data, busy, error, update, retry } = usePurchasePreparation(preparationId, api)
  const [draft, setDraft] = useState('')
  const chat = useRef<HTMLDivElement>(null)
  const ticket = useRef(new Map<string, string>())
  useEffect(() => {
    if (chat.current) chat.current.scrollTop = chat.current.scrollHeight
  }, [data?.messages.length])
  useEffect(() => { ticket.current.clear(); setDraft('') }, [preparationId])
  function requestId(key: string) {
    let value = ticket.current.get(key)
    if (!value) { value = crypto.randomUUID(); ticket.current.set(key, value) }
    return value
  }
  async function send(e: FormEvent) {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    const key = JSON.stringify(['message', text])
    if (await update(v => api.send(preparationId, v, requestId(key), text))) {
      ticket.current.delete(key)
      setDraft(current => current.trim() === text ? '' : current)
    }
  }
  async function answer(q: Question, value: Answer) {
    const key = JSON.stringify(['answer', q.question_id, value])
    if (await update(v => api.answer(preparationId, v, requestId(key), q.question_id, value))) ticket.current.delete(key)
  }
  const active = stages.findIndex(s => s.keys.includes(data?.stage.toUpperCase() ?? 'INPUT'))
  const open = data?.questions.filter(q => q.state === 'OPEN') ?? []
  const linked = new Set(data?.messages.map(m => m.question_id))
  return <main className="pp">
    <header className="pp-header"><div><h1>이번 주 매입 준비</h1>
      <p>말로 알려주시면 에이전트가 견적과 필요량을 정리해요.</p></div>
      <ol className="pp-steps" aria-label="매입 준비 단계">{stages.map((s, i) => <li key={s.label}
        aria-current={i === active ? 'step' : undefined}
        className={i === active ? 'active' : i < active ? 'done' : ''}>{i + 1} {s.label}</li>)}</ol>
    </header>
    {error && <div role="alert" className="pp-error">{error} <button className="pp-plain" onClick={retry} disabled={busy}>다시 조회</button></div>}
    {!data && !error && <p role="status">매입 준비 데이터를 불러오는 중이에요.</p>}
    {data && <div className="pp-grid">
      <section className="pp-card pp-chat">
        <div className="pp-chat-head"><h2>에이전트 대화</h2><span className="pp-chip">매입 준비</span></div>
        <div className="pp-messages" ref={chat} role="log" aria-label="에이전트 대화 내역">
          {!data.messages.length && <p>판매 계획이나 견적을 입력해 주세요.</p>}
          {data.messages.map(m => {
            const q = open.find(x => x.question_id === m.question_id)
            return <div key={m.message_id} className={`pp-bubble ${m.role === 'USER' ? 'user' : 'assistant'}`}>
              <div>{m.text}</div>
              {q && <AnswerControls key={q.question_id} q={q} busy={busy} answer={value => void answer(q, value)} />}
            </div>
          })}
          {open.filter(q => !linked.has(q.question_id)).map(q => <div key={q.question_id} className="pp-bubble assistant">
            <div>{q.message}</div><AnswerControls q={q} busy={busy} answer={value => void answer(q, value)} />
          </div>)}
          <div className="pp-badges">{([
            ['견적 정리', data.statuses.quote_status], ['필요량 계산', data.statuses.material_status],
            ['구매안 계산', data.statuses.optimization_status],
          ] as const).map(([label, status]) => <span key={label}
            className={`pp-chip ${status === 'COMPLETE' || status === 'OK' ? 'good' : ''}`}>
            {status === 'NEEDS_REVIEW' && label === '견적 정리' ? '견적 확인 필요' : `${label} ${statusLabel[status] ?? status}`}
          </span>)}</div>
          {busy && <p role="status">요청을 처리하고 있어요…</p>}
        </div>
        <form className="pp-composer" onSubmit={send}>
          <textarea aria-label="메시지 또는 견적" value={draft} onChange={e => setDraft(e.target.value)}
            rows={2} maxLength={15000} placeholder="메시지를 입력하거나 견적을 붙여넣으세요" />
          <button className="pp-primary" disabled={busy || !draft.trim()}>보내기</button>
        </form>
      </section>
      <div className="pp-panels">
        <SalesTable data={data.sales_plan} />
        <MaterialsTable data={data.material_requirements} busy={busy}
          refresh={() => void update(v => api.preview(preparationId, v))} />
        <QuotesTable data={data.quotes} issues={data.issues} />
      </div>
    </div>}
  </main>
}
