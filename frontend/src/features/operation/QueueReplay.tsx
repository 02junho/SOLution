import { useEffect, useId, useState } from 'react'
import { simulationClock, stateAt } from './replay'
import type { CustomerStage, OperationTrace } from './types'

export default function QueueReplay({ trace }: { trace: OperationTrace }) {
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(60)
  const titleId = useId()
  const duration = trace.events.reduce((last, event) => Math.max(last, event.at_seconds), trace.observation_window?.end_seconds ?? 0)
  useEffect(() => {
    if (!playing) return
    let frame = 0
    const start = performance.now()
    const initial = time
    const tick = (now: number) => {
      const next = Math.min(duration, initial + (now - start) / 1000 * speed)
      setTime(next)
      if (next >= duration) setPlaying(false)
      else frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
    // time은 재생 시작 시점의 기준값이며 프레임마다 effect를 다시 시작하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playing, speed, duration])
  const state = stateAt(trace, time)
  const buckets: { title: string; stages: CustomerStage[] }[] = [
    { title: '주문 대기', stages: ['ORDER_QUEUE'] }, { title: '주문 중', stages: ['ORDERING'] },
    { title: '제조 대기', stages: ['WAITING_PREPARATION'] }, { title: '제조·전달', stages: ['PREPARING', 'WAITING_HANDOFF'] },
  ]
  return <div className="op-replay">
    {!state.initialKnown && <p className="op-notice">시작 상태가 없는 이전 기록입니다. 아래는 기록에 등장한 고객·직원의 움직임만 보여주며, 실제 대기 인원과 전체 투입 인원을 뜻하지 않습니다.</p>}
    <div className="op-replay-status"><strong>{simulationClock(trace.time_origin, time)}</strong>
      <span>{state.initialKnown ? '이 반복의 수령 완료' : '기록상 수령 완료'} {state.completed}명</span><span>{state.initialKnown ? `투입 인원 ${state.activeStaff.size}명` : '전체 투입 인원 미확인'}</span>
      {!trace.is_complete && <span className="op-tag">부분 기록</span>}</div>
    <div className="op-replay-canvas"><svg viewBox="0 0 1000 190" role="img" aria-labelledby={titleId}>
      <title id={titleId}>시각별 주문·제조 대기열. {simulationClock(trace.time_origin, time)}</title>
      {buckets.map((bucket, i) => {
        const keys = [...state.customers].filter(([, stage]) => bucket.stages.includes(stage)).map(([key]) => key)
        return <g key={bucket.title} transform={`translate(${i * 250 + 8}, 6)`}>
          <rect width="234" height="175" rx="14" fill={i % 2 ? '#f4eee5' : '#edf3f0'} />
          <text x="18" y="30" fontSize="16" fill="#28463c">{bucket.title}</text>
          <text x="214" y="30" textAnchor="end" fontSize="16">{keys.length}명</text>
          {keys.slice(0, 10).map((key, j) => <g key={key} transform={`translate(${30 + j % 5 * 42}, ${68 + Math.floor(j / 5) * 48})`}>
            <title>{key}</title><circle r="12" fill="#3b735e" /><path d="M-13 25 Q0 3 13 25" fill="#80a591" /></g>)}
          {keys.length > 10 && <text x="214" y="158" textAnchor="end" fontSize="13">+{keys.length - 10}명</text>}
        </g>
      })}
    </svg></div>
    <label className="op-scrub">재생 시각
      <input aria-label="재생 시각" type="range" min="0" max={duration} step="1" value={time}
        onChange={e => { setPlaying(false); setTime(Number(e.target.value)) }} /></label>
    <div className="op-replay-controls">
      <button onClick={() => { if (time >= duration) setTime(0); setPlaying(!playing) }}>{playing ? '정지' : '재생'}</button>
      <button className="op-secondary" onClick={() => { setPlaying(false); setTime(0) }}>처음으로</button>
      <label>재생 속도 <select aria-label="재생 속도" value={speed} onChange={e => { setPlaying(false); setSpeed(Number(e.target.value)) }}>
        {[1, 30, 60, 300].map(v => <option key={v} value={v}>{v}배</option>)}</select></label>
      <span className="op-muted">직원 {Array.from(state.activeStaff).join(' · ')}</span>
    </div>
  </div>
}
