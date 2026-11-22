import { useEffect, useState } from 'react'
import { rosterReplay } from '../../../api/operationApi'
import { simulationClock, stateAt } from '../replay'
import type { OptionKey } from '../lab/rosterTypes'
import type { OperationTrace } from '../types'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import { clock, OPTION_NAME, staffText } from './easyRosterModel'

/*
 * 줄 서는 모습: 같은 요일·같은 손님으로 "아끼는 근무표"와 고른 근무표를 번갈아 재생한다.
 * 기록은 저장하지 않고 열 때 서버가 그 하루를 한 번 다시 돌려 만든다(결과 숫자를 낸 반복 중 첫 판).
 * 그림은 쉬운 화면의 줄 서는 모습과 같은 칸·스타일(easy-queue-*)을 쓴다.
 */

const BOXES: { title: string; stages: string[] }[] = [
  { title: '주문 줄', stages: ['ORDER_QUEUE'] },
  { title: '주문하는 중', stages: ['ORDERING'] },
  { title: '음료 기다리는 중', stages: ['WAITING_PREPARATION'] },
  { title: '만들고 건네는 중', stages: ['PREPARING', 'WAITING_HANDOFF'] },
]

const seconds = (hhmm: string) => Number(hhmm.slice(0, 2)) * 3600 + Number(hhmm.slice(3, 5)) * 60

export default function RosterQueue({
  resultId,
  day,
  windows,
  chosen,
  repetitions,
}: {
  resultId: number
  day: Weekday
  windows: { start_time: string; end_time: string }[]
  chosen: OptionKey
  /** 결과 숫자를 낸 반복 횟수(안내 문장용). 모르면 숫자 없이 말한다. */
  repetitions: number | null
}) {
  const pair: OptionKey[] = chosen === 'SAVE' ? ['SAVE', 'RECOMMENDED'] : ['SAVE', chosen]
  const [open, setOpen] = useState(false)
  const [choice, setChoice] = useState<OptionKey>(pair[1])
  const [traces, setTraces] = useState<Record<string, OperationTrace | string>>({})
  const key = `${day}:${choice}`
  const loaded = traces[key]

  useEffect(() => {
    if (!open || loaded !== undefined) return
    let alive = true
    void rosterReplay(resultId, day, choice).then(
      (response) => {
        if (!alive) return
        setTraces((t) => ({ ...t, [key]: response.status === 'ok' && response.data ? response.data : (response.message ?? '줄 서는 모습을 만들지 못했어요.') }))
      },
      () => alive && setTraces((t) => ({ ...t, [key]: '줄 서는 모습을 만들지 못했어요.' })),
    )
    return () => {
      alive = false
    }
  }, [open, loaded, resultId, day, choice, key])

  if (!open)
    return (
      <div className="er-queue-open">
        <button type="button" className="easy-secondary" onClick={() => setOpen(true)}>
          ▶ 줄 서는 모습으로 보기
        </button>
        <span className="easy-muted">같은 손님으로 아끼는 근무표와 {OPTION_NAME[pair[1]]}의 줄을 비교해요.</span>
      </div>
    )

  return (
    <div className="easy-replay er-queue">
      <div className="easy-pick" role="group" aria-label="어느 근무표로 볼까요">
        {pair.map((k) => (
          <button key={k} type="button" aria-pressed={k === choice} className={k === choice ? 'on' : ''} onClick={() => setChoice(k)}>
            {OPTION_NAME[k]}
          </button>
        ))}
      </div>
      {loaded === undefined ? (
        <p className="easy-empty">{WEEKDAY_LABEL[day]}요일 하루를 다시 돌려 보는 중이에요</p>
      ) : typeof loaded === 'string' ? (
        <p className="easy-error">{loaded}</p>
      ) : (
        <Queue key={key} trace={loaded} windows={windows} />
      )}
      <p className="easy-queue-hint">근무표 숫자를 낸 {repetitions ? `${repetitions}번` : '여러 번'} 계산 중 첫 번째 판이에요. 위의 가장 긴 대기와 조금 다를 수 있어요.</p>
    </div>
  )
}

function Queue({ trace, windows }: { trace: OperationTrace; windows: { start_time: string; end_time: string }[] }) {
  const origin = seconds(trace.time_origin)
  const duration = trace.events.reduce((last, e) => Math.max(last, e.at_seconds), trace.observation_window?.end_seconds ?? 0)
  const at = (hhmm: string) => Math.min(duration, Math.max(0, seconds(hhmm) - origin))
  const jumps = [{ label: `문 열 때 ${clock(trace.time_origin.slice(0, 5))}`, hhmm: trace.time_origin.slice(0, 5) }, ...windows.map((w) => ({ label: `바쁜 시간 ${clock(w.start_time)}`, hhmm: w.start_time }))]
  const first = windows[0]?.start_time ?? trace.time_origin.slice(0, 5)
  const [time, setTime] = useState(() => at(first))
  const [playing, setPlaying] = useState(false)
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const start = performance.now()
    const initial = time
    const tick = (now: number) => {
      const next = Math.min(duration, initial + ((now - start) / 1000) * 60) // 1초에 1분
      setTime(next)
      if (next >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // 재생을 시작할 때의 시각에서 이어 간다(프레임마다 다시 시작하지 않게).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration])
  const state = stateAt(trace, time)
  const counts = BOXES.map((box) => [...state.customers.values()].filter((stage) => box.stages.includes(stage)).length)
  const waiting = counts[0] + counts[2]
  const now = simulationClock(trace.time_origin, time)
  return (
    <div className="easy-queue">
      <div className="easy-queue-head">
        <b className="easy-queue-clock">{clock(now.slice(0, 5))}</b>
        <span>
          기다리는 손님 <b>{waiting}명</b> · 받아 간 손님 {state.completed}명
        </span>
        <span>일하는 사람: {staffText([...state.activeStaff])}</span>
      </div>
      <div className="easy-queue-boxes">
        {BOXES.map((box, i) => (
          <div key={box.title} className="easy-queue-box">
            <p>
              <span>{box.title}</span>
              <b>{counts[i]}명</b>
            </p>
            <div className="easy-queue-dots" aria-hidden>
              {Array.from({ length: Math.min(counts[i], 12) }, (_, j) => (
                <i key={j} />
              ))}
              {counts[i] > 12 && <em>+{counts[i] - 12}</em>}
            </div>
          </div>
        ))}
      </div>
      <input
        className="easy-queue-scrub"
        aria-label="보는 시각"
        type="range"
        min="0"
        max={duration}
        step="60"
        value={time}
        onChange={(e) => {
          setPlaying(false)
          setTime(Number(e.target.value))
        }}
      />
      <div className="easy-queue-controls">
        <button
          type="button"
          className="easy-primary"
          onClick={() => {
            if (time >= duration) setTime(at(first))
            setPlaying(!playing)
          }}
        >
          {playing ? '■ 멈추기' : '▶ 재생'}
        </button>
        {jumps.map((jump) => (
          <button
            key={jump.label}
            type="button"
            className="easy-secondary"
            onClick={() => {
              setPlaying(false)
              setTime(at(jump.hhmm))
            }}
          >
            {jump.label}
          </button>
        ))}
      </div>
      <p className="easy-queue-hint">1초에 1분씩 흘러가요. 막대를 끌어서 원하는 시각을 볼 수도 있어요.</p>
    </div>
  )
}
