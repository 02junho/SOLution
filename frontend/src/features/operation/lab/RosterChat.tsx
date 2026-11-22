import { useState } from 'react'
import { rosterChat } from '../../../api/operationApi'
import type { JsonObject } from '../../../types/workflow'
import type { RosterChatReply } from './rosterTypes'

/** 바꿀 수 있는 칸 정의(서버가 이 범위로 AI 답을 검사한다). */
/** label은 답장에 쓰는 짧은 이름, hint는 AI가 칸을 알아듣게 돕는 설명, unit은 숫자 뒤에 붙일 단위(선택). */
type FieldBase = { key: string; label: string; hint?: string; unit?: string }
export type ChatField =
  | (FieldBase & { type: 'int'; min: number; max: number })
  | (FieldBase & { type: 'bool'; time_min?: string; time_max?: string })
  | (FieldBase & { type: 'choice' | 'choices'; choices: string[]; choice_labels?: Record<string, string> })
  | (FieldBase & { type: 'time'; min: string; max: string; step_min: number })

export type ChatLine = { who: 'owner' | 'ai'; text: string; note?: string }

/**
 * 말로 고치기. 사장님 말을 보내면 AI가 바꿀 칸을 고르고(서버가 범위 검사), 화면이 그 값을 칸에 넣는다.
 * 답장 문구는 서버 코드가 만들고, 결과 질문 답은 결과에 있는 숫자만 쓴다.
 */
export default function RosterChat({
  fields,
  state,
  workers,
  result,
  disabled,
  lines,
  onLines,
  onReply,
}: {
  fields: ChatField[]
  state: JsonObject
  workers: JsonObject[]
  result: JsonObject | null
  disabled: boolean
  lines: ChatLine[]
  onLines: (next: ChatLine[]) => void
  onReply: (reply: RosterChatReply) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)

  async function send() {
    const message = text.trim()
    if (!message) return
    const asked = [...lines, { who: 'owner' as const, text: message }]
    onLines(asked)
    setText('')
    setBusy(true)
    try {
      const response = await rosterChat({ message, fields, state, workers, ...(result ? { result } : {}) })
      if (response.status !== 'ok' || !response.data) throw new Error(response.message ?? '말을 처리하지 못했어요.')
      const reply = response.data
      onLines([...asked, { who: 'ai', text: reply.reply, note: reply.source === 'UNAVAILABLE' ? 'AI 연결 없음' : undefined }])
      onReply(reply)
    } catch (cause) {
      onLines([...asked, { who: 'ai', text: cause instanceof Error ? cause.message : '말을 처리하지 못했어요.' }])
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="lab-chat">
      <b>말로 고치기</b>
      <small className="lab-muted">
        {' '}
        예를 들어 바꾸고 싶은 조건이나 궁금한 점을 평소 말투로 적어 주세요. 숫자 범위는 서버가 다시 확인해요.
      </small>
      {lines.length > 0 && (
        <ul className="lab-chat-lines" aria-live="polite">
          {lines.map((line, i) => (
            <li key={i} className={line.who}>
              {line.text}
              {line.note && <small className={`lab-tag ${line.note === 'AI 연결 없음' ? 'guess' : 'ai'}`}>{line.note}</small>}
            </li>
          ))}
        </ul>
      )}
      <form
        className="lab-chat-input"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          value={text}
          maxLength={300}
          placeholder="말로 적어 주세요"
          disabled={busy || disabled}
          onChange={(e) => setText(e.target.value)}
          aria-label="말로 고치기"
        />
        <button type="submit" className="button primary" disabled={busy || disabled || !text.trim()}>
          {busy ? '보내는 중' : '보내기'}
        </button>
      </form>
    </div>
  )
}
