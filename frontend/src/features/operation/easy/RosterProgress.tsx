import type { RosterProgress as Progress } from '../lab/rosterTypes'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import { mergedWindows, rangeText, waitText } from './easyRosterModel'

/*
 * 계산 중 진행 상황: 요일이 끝나는 대로 그 요일의 추천(바쁜 시간·몇 명 더·가장 긴 대기)을 먼저 보여 준다.
 * 전체 시간은 같지만 기다리는 동안 볼 것이 생겨 덜 지루하게(토스·배민의 "점진적 표시"와 같은 생각).
 * 직원 배정(누가 언제)은 모든 요일이 끝나야 해서 근무표 표는 마지막에 나온다.
 */
export default function RosterProgress({ progress }: { progress: Progress | null }) {
  if (!progress || !progress.order.length) return null
  const total = progress.total ?? progress.order.length
  return (
    <div className="er-progress">
      <p className="er-progress-head">
        {total}개 요일 중 <b>{progress.done}개</b> 끝났어요
      </p>
      <div className="er-progress-bar" aria-hidden>
        <i style={{ width: `${Math.round((progress.done / Math.max(1, total)) * 100)}%` }} />
      </div>
      <ul>
        {progress.order.map((d) => {
          const day = progress.days[d]
          const name = WEEKDAY_LABEL[d as Weekday] ?? d
          if (!day)
            return (
              <li key={d} className="wait">
                <b>{name}</b>
                <span>계산 중…</span>
              </li>
            )
          if ('failed' in day)
            return (
              <li key={d} className="fail">
                <b>{name}</b>
                <span>이 요일은 계산하지 못했어요</span>
              </li>
            )
          // 짧게: "✓ 바쁜 시간 8~14시 · 1명 더 · 가장 긴 대기 약 3분"(이어진 바쁜 시간은 하나로)
          const busy = mergedWindows(day.windows).map((w) => rangeText(w.start, w.end)).join(', ')
          return (
            <li key={d} className="done">
              <b>{name}</b>
              <span>
                ✓ {busy ? `바쁜 시간 ${busy} · ` : ''}
                {day.extra ? `${day.extra}명 더` : '추가 없이'} · 가장 긴 대기 {waitText(day.peak_wait_sec)}
              </span>
            </li>
          )
        })}
      </ul>
      <small>요일을 다 계산하면 직원을 배정해 근무표를 보여 드려요.</small>
    </div>
  )
}
