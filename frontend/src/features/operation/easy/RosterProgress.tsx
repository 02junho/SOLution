import type { RosterProgress as Progress } from '../roster/rosterTypes'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import { mergedWindows, rangeText, waitText } from './easyRosterModel'

/*
 * 계산 중 진행 상황: 요일이 끝나는 대로 그 요일의 추천(바쁜 시간·몇 명 더·가장 긴 대기)을 먼저 보여 준다.
 * 전체 시간은 같지만 기다리는 동안 볼 것이 생겨 덜 지루하게(토스·배민의 "점진적 표시"와 같은 생각).
 * 직원 배정(누가 언제)은 모든 요일이 끝나야 해서 근무표 표는 마지막에 나온다.
 */
export default function RosterProgress({ progress: real, days = [] }: { progress: Progress | null; days?: string[] }) {
  // 서버 진행 정보가 아직 없으면(앞 계산이 끝나길 줄에서 기다리는 중) 보낸 요일로 목록만 먼저 보여 준다.
  const waiting = !real || !real.order.length
  const progress: Progress | null = waiting ? (days.length ? { total: days.length, done: 0, order: days, days: {} } : null) : real
  if (!progress) return null
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
                <span>{waiting ? '차례를 기다리는 중…' : '계산 중…'}</span>
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
                {day.extra ? `${day.extra}명 더` : '추가 없이'} · 인원 추가 실험 대기 {waitText(day.peak_wait_sec)}
              </span>
            </li>
          )
        })}
      </ul>
      <small>요일을 다 계산하면 휴게시간 등을 반영한 근무표와 최종 대기시간을 보여 드려요.</small>
    </div>
  )
}
