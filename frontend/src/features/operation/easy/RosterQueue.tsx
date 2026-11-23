import { useEffect, useState } from 'react'
import { rosterReplay } from '../../../api/operationApi'
import { simulationClock, stateAt } from '../replay'
import type { OptionKey } from '../roster/rosterTypes'
import type { OperationTrace } from '../types'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import { clock, mergedWindows, OPTION_NAME, staffText } from './easyRosterModel'
import Info from './Info'

/*
 * 줄 서는 모습: 같은 요일·같은 손님으로 "인건비 절약 근무표"와 고른 근무표를 번갈아 재생한다.
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
  const [open, setOpen] = useState(true) // 처음부터 펼쳐 두고, 접을 수 있게
  const [choice, setChoice] = useState<OptionKey>(pair[1])
  const [traces, setTraces] = useState<Record<string, OperationTrace | string>>({})
  const key = `${day}:${choice}`
  const loaded = traces[key]
  /** 실패한 것만 지워 다시 부르게 한다(성공한 재생 기록은 남겨 둔다). */
  const forgetFailed = (only?: string) =>
    setTraces((t) => Object.fromEntries(Object.entries(t).filter(([k, v]) => typeof v !== 'string' || (only !== undefined && k !== only))))

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
        <span className="easy-muted">같은 손님으로 {OPTION_NAME.SAVE}와 {OPTION_NAME[pair[1]]}의 줄을 비교해요.</span>
      </div>
    )

  return (
    <div className="easy-replay er-queue">
      <button
        type="button"
        className="er-queue-close"
        onClick={() => {
          setOpen(false)
          forgetFailed() // 접었다 펴면 실패했던 것도 다시 불러온다
        }}
      >
        접기 ⌃
      </button>
      <div className="easy-pick" role="group" aria-label="어느 근무표로 볼까요">
        {pair.map((k) => (
          <button key={k} type="button" aria-pressed={k === choice} className={k === choice ? 'on' : ''} onClick={() => setChoice(k)}>
            {OPTION_NAME[k]}
          </button>
        ))}
      </div>
      {/* 불러오는 중·실패 문구만 화면 읽기 프로그램에 알린다(재생 시계는 넣지 않는다) */}
      <div role="status">
        {loaded === undefined && <p className="easy-empty">{WEEKDAY_LABEL[day]}요일 하루를 다시 돌려 보는 중이에요</p>}
        {typeof loaded === 'string' && (
          <p className="easy-error">
            {loaded}{' '}
            <button type="button" className="easy-secondary" onClick={() => forgetFailed(key)}>
              다시 시도
            </button>
          </p>
        )}
      </div>
      {loaded !== undefined && typeof loaded !== 'string' && <Queue key={key} trace={loaded} windows={windows} />}
      <Info title="이 줄은 어떻게 나온 건가요?">
        근무표 숫자를 낸 {repetitions ? `${repetitions}번` : '여러 번'} 계산 중 첫 번째 판이에요. 위의 가장 긴 대기(여러 번 평균)와 조금 다를 수 있어요.
      </Info>
    </div>
  )
}

// 재생 속도: 1초에 흘러가는 시뮬레이션 초. 1번 화면(QueueReplay)의 배속과 같은 방식, 쉬운 화면은 버튼 셋만.
const SPEEDS = [
  { perSec: 60, label: '보통', hint: '1초에 1분씩 흘러가요.' },
  { perSec: 300, label: '빠르게', hint: '1초에 5분씩 흘러가요.' },
  { perSec: 900, label: '아주 빠르게', hint: '1초에 15분씩 흘러가요.' },
]

function Queue({ trace, windows }: { trace: OperationTrace; windows: { start_time: string; end_time: string }[] }) {
  const origin = seconds(trace.time_origin)
  const duration = trace.events.reduce((last, e) => Math.max(last, e.at_seconds), trace.observation_window?.end_seconds ?? 0)
  const at = (hhmm: string) => Math.min(duration, Math.max(0, seconds(hhmm) - origin))
  // 시작 시각 버튼: "7시부터 (문 열 때)", "8시부터 (바쁠 때)"처럼 무엇을 하는 버튼인지 바로 보이게. 처음 위치는 문 여는 시각.
  const opening = trace.time_origin.slice(0, 5)
  // 이어진 바쁜 시간은 시작 하나만
  const jumps = [...new Set([opening, ...mergedWindows(windows).map((w) => w.start.slice(0, 5))])].map((hhmm) => ({ label: `${clock(hhmm)}부터 (${hhmm === opening ? '문 열 때' : '바쁠 때'})`, hhmm }))
  const first = opening
  const [time, setTime] = useState(() => at(first))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(SPEEDS[0].perSec)
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const start = performance.now()
    const initial = time
    const tick = (now: number) => {
      const next = Math.min(duration, initial + ((now - start) / 1000) * speed)
      setTime(next)
      if (next >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // 재생을 시작할 때의 시각에서 이어 간다(프레임마다 다시 시작하지 않게).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, duration, speed])
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
        <div className="easy-pick er-speed" role="group" aria-label="재생 속도">
          <span className="er-speed-label">속도</span>
          {SPEEDS.map((s) => (
            <button key={s.perSec} type="button" aria-pressed={speed === s.perSec} className={speed === s.perSec ? 'on' : ''} onClick={() => setSpeed(s.perSec)}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {/* 시작 시각은 재생 줄 아래 한 줄로(버튼 수가 늘어도 재생 줄이 길어지지 않게) */}
      <div className="easy-pick er-speed er-jumps" role="group" aria-label="어느 시각부터 볼까요">
        <span className="er-speed-label">시작 시각</span>
        {jumps.map((jump) => (
          <button
            key={jump.hhmm}
            type="button"
            onClick={() => {
              setPlaying(false)
              setTime(at(jump.hhmm))
            }}
          >
            {jump.label}
          </button>
        ))}
      </div>
      <p className="easy-queue-hint">{SPEEDS.find((s) => s.perSec === speed)?.hint} 막대를 끌어서 원하는 시각을 볼 수도 있어요.</p>
    </div>
  )
}
