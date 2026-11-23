import { useState } from 'react'
import { Pick, SaveBox } from '../../easy/views'
import type { OptionKey, RosterOptions, RosterSummary } from '../roster/rosterTypes'
import { WEEKDAY_LABEL } from '../workspace/storeFile'
import type { Weekday } from '../workspace/storeFile'
import Info from './Info'
import DayTimeline from './DayTimeline'
import RosterQueue from './RosterQueue'
import { busiestDay, capacityText, markExtraShifts, mergedWindows, periodOf, headline, ladderBars, OPTION_NAME, rangeText, repetitionsOf, shiftParts, shownDays, unfilledCells, versusText, waitText, weekRows, won, worstPeak } from './easyRosterModel'

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
  changed = null,
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
  /** 말로 바꿔 다시 계산한 결과면: 바꾼 내용 한 줄과 말로 새로 넣은 직원 이름 */
  changed?: { text: string; added: string[] } | null
}) {
  const days = shownDays(data)
  const period = periodOf(days) // 하루 근무표면 "주" 대신 "하루"
  const option = data.options.find((o) => o.key === chosen) ?? data.options[0]
  const [ladderDay, setLadderDay] = useState<Weekday | null>(() => busiestDay(data, days))
  const day = ladderDay && days.includes(ladderDay) ? ladderDay : busiestDay(data, days)
  const bars = day ? ladderBars(data, day) : []
  const windows = day ? mergedWindows(data.days[day].windows).map((w) => range(w.start, w.end)).join(', ') : '' // 이어진 바쁜 시간은 하나로
  // 하루 근무표에서만 바쁠 때 더 둔 사람(절약 안에 없는 근무)을 표시한다. 일주일 표는 요일 머리의 "바쁠 때 +N"으로 충분하다.
  const base = weekRows(option, days)
  const rows = days.length === 1 ? markExtraShifts(base, option, data.options.find((o) => o.key === 'SAVE'), days) : base
  const added = new Set(changed?.added ?? [])
  const hasExtra = rows.some((r) => r.cells.some((c) => c?.extra))
  const holes = unfilledCells(option, days)
  const peak = worstPeak(option, days)
  const recommended = data.options.find((o) => o.key === 'RECOMMENDED') ?? option
  const rules = option.days[days[0]]?.rules as { short_shift_hours?: number; long_shift_hours?: number } | undefined
  const warnings = (summary?.warnings ?? []).filter((w) => w.requires_ack && (w.choice_keys === null || w.choice_keys.includes(option.key)))
  const notes = (summary?.warnings ?? []).filter((w) => !w.requires_ack && (w.choice_keys === null || w.choice_keys.includes(option.key)))

  return (
    <>
      <section className="easy-verdict" data-tour="verdict">
        <p className="easy-label">{readOnly ? '저장한 근무표' : option.key === 'RECOMMENDED' ? '추천' : '고른 근무표'}</p>
        <h2>{headline(option, days)}</h2>
        <p>
          바쁜 시간 가장 긴 대기 <b>{waitText(peak)}</b> · 직원 <b>{option.weekly.people_used}명</b>{option.shortfall.more_people_under_15h > 0 && <> + 새로 뽑을 직원 <b>{option.shortfall.more_people_under_15h}명</b></>} (모두 주 15시간 미만) · {period.per} 인건비{' '}
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
        {explain && <Explain label={explain.ai ? 'AI 설명' : '요약'} text={explain.text} />}
      </section>

      {/* 막대 안내는 비교할 막대가 둘 이상일 때만, 요일 고르기와 줄 서는 모습은 막대 수와 상관없이 보여 준다 */}
      {day && (bars.length > 1 || days.length > 1 || resultId != null) && (
        <section className="easy-card easy-noprint">
          <h2>{bars.length > 1 ? '사람을 늘리면 대기가 얼마나 줄까요?' : '줄 서는 모습'}</h2>
          {bars.length > 1 && (
          <p className="easy-muted">
            {WEEKDAY_LABEL[day]}요일 바쁜 시간({windows})에 가장 오래 기다리는 손님 기준이에요. 더 늘려도 {Math.round(data.min_gain_sec)}초 넘게 줄지
            않으면 거기서 멈추고 그 앞을 추천해요.
          </p>
          )}
          {days.length > 1 && (
            <Pick label="요일" value={days.indexOf(day)} options={days.map((_, i) => i)} format={(i) => WEEKDAY_LABEL[days[i]]} onPick={(i) => setLadderDay(days[i])} />
          )}
          {bars.length > 1 && (
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
          )}
          {resultId != null && (
            <RosterQueue key={`${day}:${option.key}`} resultId={resultId} day={day} windows={data.days[day].windows} chosen={option.key} repetitions={repetitionsOf(data)} />
          )}
        </section>
      )}

      <section className="easy-card easy-print er-print" data-tour="detail">
        <h2>{OPTION_NAME[option.key]} · {period.title}</h2>
        <p className="easy-print-only easy-print-sign er-sign">확인 ____________</p>
        {changed && <p className="er-changed easy-noprint">바꾼 조건으로 다시 계산했어요: {changed.text}</p>}
        {days.length === 1 && <DayTimeline rows={rows} added={added} per={period.per} holes={holes?.[0]} busy={mergedWindows(data.days[days[0]]?.windows ?? [])} />}
        <div className={`er-week-wrap${days.length === 1 ? ' er-week-day' : ''}`}>
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
                    {added.has(r.name) && <small className="er-added-tag">말로 추가</small>}
                    {r.hours != null && <small>{period.per} {r.hours}시간</small>}
                    {r.pay != null && <small className="er-pay">{won(r.pay)}</small>}
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
          <span><i />지금 직원</span>
          {(option.new_hires?.length ?? 0) > 0 && <span><i className="hire" />새로 뽑을 직원</span>}
          <span><i className="rest" />휴게 있음(4시간 넘게 일하면 30분, 무급)</span>
          {hasExtra && <span><i className="extra" />바쁠 때 더 둔 사람</span>}
          {days.length === 1 && <span className="er-legend-busy"><i className="busy" />바쁜 시간(위 눈금 · 이때 사람을 더 둬요)</span>}
        </p>
        {capacityText(option, days) && <p className="er-warn easy-noprint">{capacityText(option, days)}</p>}
        {option.shortfall.more_people_under_15h > 0 && (
          <p className="er-warn easy-noprint">
            {option.new_hires
              ? `지금 직원 ${option.weekly.workers.length}명으로는 ${period.within} ${option.shortfall.unfilled_hours}시간이 비어요. 직원 ${option.shortfall.more_people_under_15h}명을 더 뽑으면 이 근무표대로 돌아가요.`
              : `지금 직원 ${option.weekly.workers.length}명으로는 ${period.within} ${option.shortfall.unfilled_hours}시간이 비어요. 직원 ${option.shortfall.more_people_under_15h}명이 더 필요해요.`}
          </p>
        )}
        <div className="easy-noprint">
          <Info title="직원은 이렇게 일해요">
            <ul>
              <li>
                한 번에 {rules?.short_shift_hours ?? 3.5}~{rules?.long_shift_hours ?? 7.5}시간씩(쉬는 시간 포함), 하루에 한 번만 일해요. 예: 7시간 근무 + 30분 휴게를 이틀이면 주 14시간이에요.
              </li>
              <li>직원마다 일할 수 있는 요일·시간 안에서만 넣어요.</li>
              <li>모두 주 15시간 미만이라 주휴수당이 없어요. 새로 뽑을 직원도 같아요.</li>
              <li>4시간 넘게 일하면 30분 쉬어요(무급). 바쁜 시간을 피해 넣었고, 근무 중간이면 옮겨도 돼요(처음·끝은 안 돼요).</li>
              <li>"주 ○시간"은 쉬는 시간을 뺀, 실제로 돈을 받는 시간이에요. 옆의 금액은 이 근무표대로 일할 때 주 예상 급여예요(세전, 보험·가산수당 빼고).</li>
            </ul>
          </Info>
        </div>
        {/* 저장한 계획 보기(readOnly)에서도 인쇄는 된다(고치기·저장만 막는다) */}
        <div className="easy-actions easy-noprint">
          <button type="button" className="easy-secondary" onClick={() => window.print()}>근무표 인쇄</button>
        </div>
      </section>

      {/* 따라 하며 배우기 6단계는 비교와 바로 아래 말 칸을 함께 비춘다 */}
      <div data-tour="compare">
      {/* 세 근무표 비교: 펼쳐 두되 접을 수 있게(근무표만 보고 싶을 때) */}
      <details className="easy-card easy-noprint er-fold" open>
        <summary>
          <h2>세 근무표 비교</h2>
        </summary>
        <div className="er-compare">
          {data.options.map((o) => (
            <button key={o.key} type="button" className={`er-option${o.key === option.key ? ' on' : ''}`} aria-pressed={o.key === option.key} disabled={readOnly} onClick={() => onChoose(o.key)}>
              {o.key === 'RECOMMENDED' && <span className="er-badge">추천</span>}
              <b>{OPTION_NAME[o.key]}</b>
              <span>가장 긴 대기</span>
              <strong>{waitText(worstPeak(o, days))}</strong>
              <span>{period.per} 인건비</span>
              <strong>{won(o.plan_cost_krw)}</strong>
              <span>직원 {o.weekly.people_used}명{o.shortfall.more_people_under_15h > 0 ? ` · ${o.shortfall.more_people_under_15h}명 더 필요` : ''}</span>
              {versusText(o, recommended, days) && <em className="er-versus">{versusText(o, recommended, days)}</em>}
            </button>
          ))}
        </div>
      </details>

      {!readOnly && chat}
      </div>

      <section className="easy-card easy-noprint er-save" data-tour="save">
        {readOnly ? (
          <p className="easy-done">{saved}</p>
        ) : (
          <SaveBox
            key={option.key}
            lines={[
              `${OPTION_NAME[option.key]} · 바쁜 시간 가장 긴 대기 ${waitText(peak)}`,
              `${period.per} 인건비 ${won(option.plan_cost_krw)} · 직원 ${option.weekly.people_used}명${option.shortfall.more_people_under_15h > 0 ? ` + 새로 뽑을 직원 ${option.shortfall.more_people_under_15h}명` : ''}(모두 주 15시간 미만)`,
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

/** 결과 설명: 첫 문장만 보이고 나머지는 "더 보기"(AI 설명이 길어 결론을 밀어내지 않게). */
function Explain({ label, text }: { label: string; text: string }) {
  const [open, setOpen] = useState(false)
  const sentences = text.split(/(?<=[.!?])\s+/).filter(Boolean)
  const rest = sentences.slice(1).join(' ')
  return (
    <p className="er-explain">
      <b>{label}</b> {sentences[0] ?? text}
      {rest && (open ? <> {rest}</> : null)}
      {rest && (
        <button type="button" className="er-more" onClick={() => setOpen(!open)}>
          {open ? '접기' : '더 보기'}
        </button>
      )}
    </p>
  )
}
