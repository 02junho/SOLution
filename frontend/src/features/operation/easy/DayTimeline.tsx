import type { WeekRow } from './easyRosterModel'
import { shiftText } from './easyRosterModel'

/*
 * 하루 근무표를 시간 막대로: 사람마다 한 줄, 가로가 시간(문 여는 시각 ~ 닫는 시각).
 * 일주일 표(요일 칸)를 요일 하나로 보면 칸 하나에 시간만 적혀 "언제 겹치는지"가 안 보여서, 하루일 때만 이 모양으로 그린다.
 */
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))
const BREAK = /(\d{1,2}):(\d{2})~(\d{1,2}):(\d{2})/

/** holes: 그날 못 채운 시간 글자(unfilledCells의 첫 칸). 있으면 맨 아래 "빈 자리" 줄로 보여 준다(일주일 표와 같게). */
/** busy: 그날 바쁜 시간(이어진 구간은 하나로). 막대 뒤에 옅은 띠로 깔아 "바쁠 때 더 둔 사람"이 보이게 한다. */
/** added: 말로 새로 넣은 직원 이름(이름 옆에 표시). */
export default function DayTimeline({ rows, per, holes, busy = [], added }: { rows: WeekRow[]; per: string; holes?: string | null; busy?: { start: string; end: string }[]; added?: Set<string> }) {
  const cells = rows.map((r) => r.cells[0]).filter((c): c is NonNullable<typeof c> => Boolean(c))
  if (!cells.length) return null
  const from = Math.floor(Math.min(...cells.map((c) => minutes(c.start))) / 60) * 60
  const to = Math.ceil(Math.max(...cells.map((c) => minutes(c.end))) / 60) * 60
  const span = Math.max(60, to - from)
  const at = (m: number) => `${((m - from) / span) * 100}%`
  const hours = Array.from({ length: span / 60 + 1 }, (_, i) => from + i * 60)
  return (
    <div className="er-day">
      <div className="er-day-row er-day-head" aria-hidden>
        <span />
        <div className="er-day-track">
          {hours.map((h) => (
            <i key={h} style={{ left: at(h) }}>
              {h / 60}시
            </i>
          ))}
        </div>
      </div>
      {rows.map((r) => {
        const c = r.cells[0]
        return (
          <div key={r.key} className={`er-day-row${r.owner ? ' owner' : r.hire ? ' hire' : ''}`}>
            <span className="er-day-name">
              <b>{r.name}</b>
              {added?.has(r.name) && <small className="er-added-tag">말로 추가</small>}
              {r.hours != null && <small>{per} {r.hours}시간</small>}
            </span>
            <div className="er-day-track">
              {busy.map((b) => (
                <i key={b.start} className="er-day-busy" style={{ left: at(minutes(b.start)), width: `${((minutes(b.end) - minutes(b.start)) / span) * 100}%` }} aria-hidden />
              ))}
              {hours.map((h) => (
                <i key={h} className="er-day-grid" style={{ left: at(h) }} aria-hidden />
              ))}
              {c && (
                <span className={`er-day-bar${c.extra ? ' extra' : ''}`} style={{ left: at(minutes(c.start)), width: `${((minutes(c.end) - minutes(c.start)) / span) * 100}%` }}>
                  {shiftText(c.start, c.end)}
                  {c.breaks.map((b) => {
                    const m = b.match(BREAK)
                    if (!m) return null
                    const s = Number(m[1]) * 60 + Number(m[2])
                    const e = Number(m[3]) * 60 + Number(m[4])
                    const len = minutes(c.end) - minutes(c.start)
                    return (
                      <em
                        key={b}
                        className="er-day-rest"
                        title={`휴게 ${b}`}
                        style={{ left: `${((s - minutes(c.start)) / len) * 100}%`, width: `${((e - s) / len) * 100}%` }}
                      />
                    )
                  })}
                </span>
              )}
            </div>
          </div>
        )
      })}
      {holes && (
        <div className="er-day-row er-day-need">
          <span className="er-day-name">
            <b>빈 자리</b>
          </span>
          <span>{holes}</span>
        </div>
      )}
    </div>
  )
}
