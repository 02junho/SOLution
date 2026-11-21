import { useEffect, useRef, useState } from 'react'
import { planDailyRoster } from '../../../api/operationApi'
import type { JsonObject } from '../../../types/workflow'
import type { DailyRoster, RosterShift } from './rosterTypes'

/*
 * 하루 근무표 만들기(운영 2번 확장 D). 확인한 가게 조건으로 시간대별 필요 인원을 찾고, 근무조로 덮고, 휴게를 넣어
 * 다시 돌려 확인한 결과를 보여 준다. 저장하지 않는 미리보기다.
 */

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3))
const fromMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
const halfHours = (from: string, to: string) => {
  const out: string[] = []
  for (let m = toMin(from); m <= toMin(to); m += 30) out.push(fromMin(m))
  return out
}
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`
const kindText = (s: RosterShift) => (s.is_owner ? '사장님' : s.kind === 'LONG' ? '긴 조' : '짧은 조')

export default function RosterCard({
  form,
  ownerWorking,
  open,
  close,
  disabled,
  autoRun = 0,
  onAutoDone,
}: {
  form: JsonObject
  ownerWorking: boolean
  open: string
  close: string
  disabled: boolean
  /** 늘어나면(한 번에 계산) 바로 만든다. */
  autoRun?: number
  /** 한 번에 계산으로 만든 뒤 부른다(다음 계산을 이어서 돌리게). */
  onAutoDone?: () => void
}) {
  const [ownerStart, setOwnerStart] = useState(open)
  const [ownerEnd, setOwnerEnd] = useState(close)
  const [roster, setRoster] = useState<DailyRoster | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const times = halfHours(open, close)
  const start = times.includes(ownerStart) ? ownerStart : open
  const end = times.includes(ownerEnd) && ownerEnd > start ? ownerEnd : close

  async function make() {
    setBusy(true)
    setError('')
    setRoster(null)
    const response = await planDailyRoster({
      operation_form: form,
      ...(ownerWorking ? { owner_start_time: start, owner_end_time: end } : {}),
    })
    setBusy(false)
    if (response.status === 'ok' && response.data) setRoster(response.data)
    else setError(response.message ?? '근무표를 만들지 못했어요.')
  }

  const lastAuto = useRef(autoRun)
  const makeRef = useRef(make)
  const doneRef = useRef(onAutoDone)
  useEffect(() => {
    makeRef.current = make
    doneRef.current = onAutoDone
  })
  useEffect(() => {
    if (autoRun === lastAuto.current) return
    lastAuto.current = autoRun
    void makeRef.current().finally(() => doneRef.current?.())
  }, [autoRun])

  const span = toMin(close) - toMin(open)
  const pos = (t: string) => `${((toMin(t) - toMin(open)) / span) * 100}%`
  const width = (a: string, b: string) => `${((toMin(b) - toMin(a)) / span) * 100}%`

  return (
    <section className="lab-card">
      <h2>4. 하루 근무표 만들기</h2>
      <p className="lab-muted">
        위 조건으로 시간대마다 대기 기준을 지키는 가장 적은 인원을 찾고, 그 인원을 근무조(짧은 조 4시간 ~ 긴 조 8시간)로
        덮어요. 휴게를 넣은 뒤 같은 손님 조건으로 30번 다시 돌려 확인하고, 모자라면 짧은 조를 더해요. 저장하지 않는
        미리보기예요.
      </p>
      <div className="lab-row">
        {ownerWorking ? (
          <>
            <label>
              사장님 근무 시작
              <select value={start} disabled={disabled || busy} onChange={(e) => setOwnerStart(e.target.value)}>
                {times.slice(0, -1).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
            <label>
              사장님 근무 끝
              <select value={end} disabled={disabled || busy} onChange={(e) => setOwnerEnd(e.target.value)}>
                {times.filter((t) => t > start).map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            </label>
          </>
        ) : (
          <span className="lab-muted">사장님은 근무하지 않아요(위 조건). 직원만으로 근무표를 만들어요.</span>
        )}
        <button type="button" className="button primary" disabled={disabled || busy} onClick={() => void make()}>
          {busy ? '근무표 만드는 중…' : '하루 근무표 만들기'}
        </button>
      </div>
      {busy && (
        <p className="lab-status" role="status">
          시간대별 필요 인원을 찾고 휴게까지 넣어 다시 돌리고 있어요. 보통 10~30초 걸려요…
        </p>
      )}
      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}

      {roster && (
        <>
          <div className="lab-totals">
            <div>
              <small>직원 근무</small>
              <b>
                {roster.shifts.filter((s) => !s.is_owner).length}명 · 유급 {roster.cost.employee_paid_hours}시간
              </b>
            </div>
            <div>
              <small>하루 직원 인건비</small>
              <b>{won(roster.cost.cash_cost_krw)}</b>
            </div>
            <div>
              <small>휴게 포함 확인</small>
              <b className={roster.verification.passes ? '' : 'lab-error'}>
                {roster.repetitions}번 중 {Math.round(roster.verification.pass_rate * roster.repetitions)}번 기준 통과
              </b>
            </div>
            <div>
              <small>주문 후 받기 P90 평균</small>
              <b>
                {roster.verification.p90_post_order_receipt_sec != null
                  ? `${(roster.verification.p90_post_order_receipt_sec / 60).toFixed(1)}분`
                  : '—'}
              </b>
            </div>
          </div>

          {roster.empty_periods.length > 0 && (
            <div className="lab-warn" role="alert">
              <b>
                매장이 비는 때:{' '}
                {roster.empty_periods.map((p) => `${p.start_time}~${p.end_time}`).join(', ')}
              </b>
              <p>
                혼자 일하는 직원의 휴게 시간이에요. 주문이 적어 대기 기준은 지켰지만 그동안 손님을 받을 사람이 없어요. 사장님이
                잠깐 맡거나, 그 시간에 짧은 조를 더하거나, 근무 시간을 겹치게 조정해 주세요.
              </p>
            </div>
          )}

          <div className="lab-gantt" role="table" aria-label="하루 근무표">
            <div className="lab-gantt-axis" role="row">
              <span role="columnheader" />
              <div>
                {halfHours(open, close)
                  .filter((t) => t.endsWith(':00'))
                  .map((t) => (
                    <small key={t} style={{ left: pos(t) }}>
                      {t.slice(0, 2)}
                    </small>
                  ))}
                <i className="lab-gantt-peak" style={{ left: pos(roster.scenario.peak_start_time), width: width(roster.scenario.peak_start_time, roster.scenario.peak_end_time) }} />
              </div>
            </div>
            {roster.shifts.map((s) => {
              const name = s.is_owner ? '사장님' : `직원 ${roster.shifts.filter((x) => !x.is_owner).indexOf(s) + 1}`
              return (
                <div key={s.worker_key} className="lab-gantt-row" role="row">
                  <span role="rowheader">
                    <b>{name}</b>
                    <small>
                      {kindText(s)} · {s.start_time}~{s.end_time}
                      {s.breaks.length > 0 && ` · 휴게 ${s.breaks.map((b) => `${b.start_time}~${b.end_time}`).join(', ')}`}
                    </small>
                  </span>
                  <div role="cell">
                    <i className={s.is_owner ? 'owner' : s.kind === 'LONG' ? 'long' : 'short'} style={{ left: pos(s.start_time), width: width(s.start_time, s.end_time) }} />
                    {s.breaks.map((b) => (
                      <i key={b.start_time} className="rest" style={{ left: pos(b.start_time), width: width(b.start_time, b.end_time) }} />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
          <p className="lab-muted">진한 파란 띠는 바쁜 시간, 빗금은 휴게예요.</p>

          <table className="lab-menus">
            <thead>
              <tr>
                <th>시간대</th>
                <th>주문</th>
                <th>필요 인원</th>
                <th>근무표 인원</th>
              </tr>
            </thead>
            <tbody>
              {roster.required_by_slot.map((r) => (
                <tr key={r.slot}>
                  <td>{r.slot.replace('-', '~')}</td>
                  <td>{r.orders}건</td>
                  <td>
                    {r.required_staff}명{r.owner_present ? ' (사장님 포함)' : ''}
                    {r.pass_rate == null && <small> · 주문이 적어 최소 인원</small>}
                  </td>
                  <td>
                    {r.on_roster_min === r.on_roster_max ? `${r.on_roster_max}명` : `${r.on_roster_min}~${r.on_roster_max}명`}
                    {r.on_roster_min < r.required_staff && <small> · 휴게 동안 줄어듦</small>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {(roster.required_fixes.length > 0 || roster.verification.repairs.length > 0) && (
            <div className="lab-defaults">
              <b>보강한 것</b>
              <ul>
                {roster.required_fixes.map((f) => (
                  <li key={`f${f.slot}`}>
                    {f.slot.replace('-', '~')}: {f.reason}
                  </li>
                ))}
                {roster.verification.repairs.map((r) => (
                  <li key={`r${r.slot}${r.added}`}>
                    {r.slot.replace('-', '~')}: {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="lab-defaults">
            <b>계산 방식과 가정</b>
            <ul>
              {roster.assumptions.map((a) => (
                <li key={a}>{a}</li>
              ))}
              <li>{roster.cost.basis}</li>
            </ul>
          </div>
        </>
      )}
    </section>
  )
}
