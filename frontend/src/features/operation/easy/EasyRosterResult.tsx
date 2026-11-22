import { useState } from 'react'
import { Pick, SaveBox } from '../../easy/views'
import type { OptionKey, RosterOptions, RosterSummary } from '../lab/rosterTypes'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import RosterQueue from './RosterQueue'
import { averagePeak, busiestDay, headline, ladderBars, OPTION_NAME, rangeText, repetitionsOf, shiftParts, shownDays, unfilledCells, waitText, weekRows, won } from './easyRosterModel'

/*
 * 쉬운 화면 추천 근무표 결과. 결론(추천 한 줄) → 왜 이 인원인지(사람을 늘리면 대기가 얼마나 줄까) → 일주일 근무표 →
 * 세 근무표 비교 → 저장 순서. 숫자는 모두 서버 결과 그대로이고, AI 설명은 결과에 있는 숫자만 쓴 문장만 보인다.
 */

const range = rangeText

export default function EasyRosterResult({
  resultId,
  data,
  summary,
  chosen,
  onChoose,
  explain,
  saved,
  readOnly,
  onSave,
  chat,
}: {
  /** 저장된 결과 번호(줄 서는 모습을 서버가 이 결과에서 다시 만든다). 없으면 줄 서는 모습을 숨긴다. */
  resultId: number | null
  data: RosterOptions
  summary: RosterSummary | null
  chosen: OptionKey
  onChoose: (key: OptionKey) => void
  /** AI 설명(없으면 숨김). ai=false면 코드가 만든 요약 문장. */
  explain: { text: string; ai: boolean } | null
  /** 저장했으면 안내 문장 */
  saved: string
  /** 저장한 계획 보기(고르기·저장·말로 고치기 없음) */
  readOnly: boolean
  onSave: (key: OptionKey, acks: string[]) => Promise<void>
  /** 말로 고치기 칸(결과 아래). */
  chat: React.ReactNode
}) {
  const days = shownDays(data)
  const option = data.options.find((o) => o.key === chosen) ?? data.options[0]
  const [ladderDay, setLadderDay] = useState<Weekday | null>(() => busiestDay(data, days))
  const day = ladderDay && days.includes(ladderDay) ? ladderDay : busiestDay(data, days)
  const bars = day ? ladderBars(data, day) : []
  const windows = day ? data.days[day].windows.map((w) => range(w.start_time, w.end_time)).join(', ') : ''
  const rows = weekRows(option, days)
  const holes = unfilledCells(option, days)
  const peak = averagePeak(option, days)
  const warnings = (summary?.warnings ?? []).filter((w) => w.requires_ack && (w.choice_keys === null || w.choice_keys.includes(option.key)))
  const notes = (summary?.warnings ?? []).filter((w) => !w.requires_ack && (w.choice_keys === null || w.choice_keys.includes(option.key)))

  return (
    <>
      <section className="easy-verdict" data-tour="verdict">
        <p className="easy-label">{readOnly ? '저장한 근무표' : option.key === 'RECOMMENDED' ? '추천' : '고른 근무표'}</p>
        <h2>{headline(option, days)}</h2>
        <p>
          바쁜 시간 가장 긴 대기 <b>{waitText(peak)}</b> · 알바 <b>{option.weekly.people_used}명</b> (모두 주 15시간 미만) · 주 인건비{' '}
          <b>{won(option.plan_cost_krw)}</b>
        </p>
        {!readOnly && (
          <div className="easy-pick easy-choose" role="group" aria-label="어느 근무표로 볼까요">
            {data.options.map((o) => (
              <button key={o.key} type="button" className={o.key === option.key ? 'on' : ''} aria-pressed={o.key === option.key} onClick={() => onChoose(o.key)}>
                {OPTION_NAME[o.key]}
                {o.key === 'RECOMMENDED' ? ' (추천)' : ''}
              </button>
            ))}
          </div>
        )}
        {explain && (
          <p className="er-explain">
            <b>{explain.ai ? 'AI 설명' : '요약'}</b> {explain.text}
          </p>
        )}
      </section>

      {day && bars.length > 1 && (
        <section className="easy-card easy-noprint">
          <h2>사람을 늘리면 대기가 얼마나 줄까요?</h2>
          <p className="easy-muted">
            {WEEKDAY_LABEL[day]}요일 바쁜 시간({windows})에 가장 오래 기다리는 손님 기준이에요. 더 늘려도 {Math.round(data.min_gain_sec)}초 넘게 줄지
            않으면 거기서 멈추고 그 앞을 추천해요.
          </p>
          {days.length > 1 && (
            <Pick label="요일" value={days.indexOf(day)} options={days.map((_, i) => i)} format={(i) => WEEKDAY_LABEL[days[i]]} onPick={(i) => setLadderDay(days[i])} />
          )}
          <div className="er-ladder" role="img" aria-label={bars.map((b) => `${b.label} ${waitText(b.sec)}`).join(', ')}>
            {bars.map((b) => (
              <div key={b.extra} className={`er-bar${b.pick === 'RECOMMENDED' ? ' pick' : ''}`}>
                <b>{waitText(b.sec)}</b>
                <div style={{ height: `${Math.max(6, b.ratio * 100)}%` }} />
                <span>
                  {b.label}
                  {b.pick === 'RECOMMENDED' ? ' (추천)' : ''}
                </span>
              </div>
            ))}
          </div>
          {resultId != null && (
            <RosterQueue key={`${day}:${option.key}`} resultId={resultId} day={day} windows={data.days[day].windows} chosen={option.key} repetitions={repetitionsOf(data)} />
          )}
        </section>
      )}

      <section className="easy-card easy-print" data-tour="detail">
        <h2>{OPTION_NAME[option.key]} · 일주일</h2>
        <div className="er-week-wrap">
          <table className="er-week">
            <thead>
              <tr>
                <th scope="col">사람</th>
                {days.map((d) => (
                  <th key={d} scope="col">
                    {WEEKDAY_LABEL[d]}
                    {option.extra_by_day[d] > 0 && <small>바쁠 때 +{option.extra_by_day[d]}</small>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className={r.owner ? 'owner' : r.hire ? 'hire' : ''}>
                  <th scope="row">
                    {r.name}
                    {r.hours != null && <small>주 {r.hours}시간</small>}
                  </th>
                  {r.cells.map((c, i) => (
                    <td key={days[i]}>
                      {c && (
                        <span className={`er-shift${c.breaks.length ? ' rest' : ''}`}>
                          <span className="er-time">
                            {shiftParts(c.start, c.end).map((part) => (
                              <span key={part}>{part}</span>
                            ))}
                          </span>
                          {c.breaks.length > 0 && <small>휴게 {c.breaks.join(', ')}</small>}
                        </span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
              {holes && (
                <tr className="need">
                  <th scope="row">빈 자리</th>
                  {holes.map((h, i) => (
                    <td key={days[i]}>{h}</td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="easy-legend er-legend">
          <span><i className="owner" />사장님</span>
          <span><i />알바</span>
          {(option.new_hires?.length ?? 0) > 0 && <span><i className="hire" />새로 뽑을 알바</span>}
          <span><i className="rest" />휴게 있음(4시간 넘게 일하면 30분, 무급)</span>
        </p>
        {option.shortfall.more_people_under_15h > 0 && (
          <p className="er-warn">
            {option.new_hires
              ? `지금 알바 명단으로는 ${option.shortfall.unfilled_hours}시간이 비어서, 알바 ${option.shortfall.more_people_under_15h}명을 더 뽑으면 이 근무표대로 돌아가요(모두 주 15시간 미만).`
              : `지금 알바 명단으로는 ${option.shortfall.unfilled_hours}시간이 비어요. 주 15시간 미만으로 채우려면 알바 ${option.shortfall.more_people_under_15h}명이 더 필요해요.`}
          </p>
        )}
        <p className="easy-print-only easy-print-sign">확인 ____________</p>
        {!readOnly && (
          <div className="easy-actions easy-noprint">
            <button type="button" className="easy-secondary" onClick={() => window.print()}>근무표 인쇄</button>
          </div>
        )}
      </section>

      <section className="easy-card easy-noprint">
        <h2>세 근무표 비교</h2>
        <div className="er-compare">
          {data.options.map((o) => (
            <button key={o.key} type="button" className={`er-option${o.key === option.key ? ' on' : ''}`} disabled={readOnly} onClick={() => onChoose(o.key)}>
              {o.key === 'RECOMMENDED' && <span className="er-badge">추천</span>}
              <b>{OPTION_NAME[o.key]}</b>
              <span>가장 긴 대기</span>
              <strong>{waitText(averagePeak(o, days))}</strong>
              <span>주 인건비</span>
              <strong>{won(o.plan_cost_krw)}</strong>
              <span>알바 {o.weekly.people_used}명{o.shortfall.more_people_under_15h > 0 ? ` · ${o.shortfall.more_people_under_15h}명 더 필요` : ''}</span>
            </button>
          ))}
        </div>
      </section>

      {!readOnly && chat}

      <section className="easy-card easy-noprint er-save" data-tour="save">
        {readOnly ? (
          <p className="easy-done">{saved}</p>
        ) : (
          <SaveBox
            key={option.key}
            lines={[
              `${OPTION_NAME[option.key]} · 바쁜 시간 가장 긴 대기 ${waitText(peak)}`,
              `주 인건비 ${won(option.plan_cost_krw)} · 알바 ${option.weekly.people_used}명${option.shortfall.more_people_under_15h > 0 ? ` + 새로 뽑을 알바 ${option.shortfall.more_people_under_15h}명` : ''}(모두 주 15시간 미만)`,
              ...notes.map((n) => n.message),
            ]}
            warnings={warnings}
            saved={saved}
            onSave={(acks) => onSave(option.key, acks)}
          />
        )}
      </section>
    </>
  )
}
