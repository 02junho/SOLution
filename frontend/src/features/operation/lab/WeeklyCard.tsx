import { useEffect, useRef, useState } from 'react'
import { loadRosterResult, planRosterOptions, startRosterResult } from '../../../api/operationApi'
import { workflowApi } from '../../../api/workflowApi'
import type { JsonObject } from '../../../types/workflow'
import { wageFloor } from '../workspace/operationInput'
import { WEEKDAY_LABEL, WEEKDAYS } from '../workspace/storeFile'
import type { StorePlan, Weekday } from '../workspace/storeFile'
import { pendingHash, rememberHash, resultHash, waitRoster } from './rosterJob'
import { optionsFromStored } from './rosterTypes'
import { ALL_DAYS, example, fromMin, MAX_TEAM, toMin, WEEKDAYS_ONLY } from './team'
import type { Person, Team } from './team'
import type { OptionKey, RosterOptions, RosterSummary } from './rosterTypes'

/*
 * 일주일 근무표(운영 2번 확장 E). 요일별 조건을 한 번에 보내면 서버가 요일마다 필요 인원을 한 번 찾고, 같은 필요 인원으로
 * 근무조를 두 가지(주휴 포함 / 주 15시간 미만)로 만든 뒤 직원 명단에 배정한다. 요일 계산은 서버가 동시에 돌린다.
 * 저장하지 않는 미리보기다.
 */

const MAX_PEOPLE = MAX_TEAM
const minutes = (sec: number | null | undefined) => (sec == null ? '—' : `${(sec / 60).toFixed(1)}분`)
const avg = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x != null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}
const won = (n: number) => `${n.toLocaleString('ko-KR')}원`

export default function WeeklyCard({
  weekdays,
  planFor,
  formFor,
  ownerWorking,
  wage,
  disabled,
  autoRun = 0,
  saved = null,
  open,
  close,
  team,
  onTeam,
  onOptions,
}: {
  weekdays: Weekday[]
  planFor: (day: Weekday) => StorePlan
  formFor: (plan: StorePlan) => JsonObject
  ownerWorking: boolean
  wage: string
  disabled: boolean
  /** 늘어나면(한 번에 계산) 바로 만든다. */
  autoRun?: number
  /** 저장한 업무·확인한 입력 버전. 있으면 근무표를 그 업무의 결과로 저장하고, 고른 안을 확정할 수 있다. 없으면 미리보기. */
  saved?: { sessionId: number; versionId: number } | null
  /** 가게 영업시간(평균 하루). 예시 명단·사장님 근무·새 직원의 기본 시간을 여기서 정한다. */
  open: string
  close: string
  team: Team
  onTeam: (next: Team) => void
  /** 추천 근무표가 나오면 부른다(말로 고치기가 결과를 묻고 설명할 때 씀). */
  onOptions?: (data: RosterOptions, summary: RosterSummary | null) => void
}) {
  const [stored, setStored] = useState<{ resultId: number; versionId: number; summary: RosterSummary } | null>(null)
  const [confirmed, setConfirmed] = useState<OptionKey | null>(null)
  const { people, ownerDays, ownerStart, ownerEnd } = team
  const setPeople = (next: Person[]) => onTeam({ ...team, people: next })
  const setOwnerDays = (next: Weekday[]) => onTeam({ ...team, ownerDays: next })
  const setOwnerStart = (next: string) => onTeam({ ...team, ownerStart: next })
  const setOwnerEnd = (next: string) => onTeam({ ...team, ownerEnd: next })
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [shown, setShown] = useState<Weekday[]>([])
  const [skipped, setSkipped] = useState<string[]>([])
  const [options, setOptions] = useState<RosterOptions | null>(null)
  const [chosen, setChosen] = useState<OptionKey>('RECOMMENDED')
  const busy = status !== ''

  const patch = (id: number, change: Partial<Person>) => setPeople(people.map((p) => (p.id === id ? { ...p, ...change } : p)))
  const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value])
  const problems = people.flatMap((p) => {
    const out: string[] = []
    if (!p.name.trim()) out.push('이름이 빈 직원이 있어요.')
    if (!/^\d+$/.test(p.wage) || Number(p.wage) < wageFloor()) out.push(`${p.name || '직원'}: 시급을 최저시급 이상으로 적어 주세요.`)
    if (!/^\d+$/.test(p.maxHours) || Number(p.maxHours) < 1 || Number(p.maxHours) > 52) out.push(`${p.name || '직원'}: 주 최대 근무시간은 1~52시간이에요.`)
    if (p.start >= p.end) out.push(`${p.name || '직원'}: 가능 시간이 거꾸로예요.`)
    if (!p.days.length) out.push(`${p.name || '직원'}: 가능 요일을 하나 이상 골라 주세요.`)
    return out
  })
  if (new Set(people.map((p) => p.name.trim())).size !== people.length) problems.push('직원 이름이 겹쳐요.')
  if (ownerWorking && ownerStart >= ownerEnd) problems.push('사장님 근무 시간이 거꾸로예요.')

  async function make() {
    if (problems.length) return
    setError('')
    setOptions(null)
    const skip: string[] = []
    const days: JsonObject[] = []
    for (const day of weekdays) {
      const plan = planFor(day)
      if (!plan.open || !plan.close || plan.problems.length) {
        skip.push(`${WEEKDAY_LABEL[day]}요일: ${plan.problems[0] ?? '시간대 데이터가 없어요.'}`)
        continue
      }
      const works = ownerWorking && ownerDays.includes(day)
      const start = fromMin(Math.max(toMin(ownerStart), toMin(plan.open)))
      const end = fromMin(Math.min(toMin(ownerEnd), toMin(plan.close)))
      const ownerToday = works && start < end
      days.push({
        day,
        operation_form: { ...formFor(plan), is_owner_working: ownerToday },
        ...(ownerToday ? { owner_start_time: start, owner_end_time: end } : {}),
      })
    }
    if (!days.length) {
      setSkipped(skip)
      setError('근무표를 만들 요일이 없어요.')
      return
    }
    setStatus(`${days.length}개 요일마다 꼭 필요한 인원을 찾고, 바쁜 시간에 사람을 더해 보며 세 가지 안을 만드는 중이에요. 1~2분 걸려요`)
    try {
      const workers = people.map((p) => ({
        worker_key: p.name.trim(),
        name: p.name.trim(),
        hourly_wage_krw: Number(p.wage),
        is_minor: p.minor,
        max_weekly_hours: Number(p.maxHours),
        available: Object.fromEntries(p.days.map((d) => [d, [p.start, p.end]])),
      }))
      setStored(null)
      setConfirmed(null)
      let data: RosterOptions
      let summary: RosterSummary | null = null
      if (saved) {
        // 업무가 있으면 서버가 뒤에서 계산해 결과로 저장한다. 화면은 끝났는지 확인만 하고, 끝나면 저장된 상세를 읽어 그린다.
        const pending = { sessionId: saved.sessionId, versionId: saved.versionId, key: crypto.randomUUID() }
        const started = await startRosterResult(saved.sessionId, { input_version_id: saved.versionId, days, workers }, pending.key)
        if (started.status !== 'ok' || !started.data) {
          setError(started.message ?? '추천 근무표 계산을 시작하지 못했어요.')
          return
        }
        rememberHash(pendingHash(pending))
        const job =
          started.data.state === 'DONE'
            ? started.data
            : await waitRoster(pending, (sec) =>
                setStatus(
                  `추천 근무표를 만드는 중이에요(${sec}초). 화면을 나가도 서버에서 계속 계산해요. 지금 주소를 다시 열면 이어서 볼 수 있어요`,
                ),
              )
        if (!job?.result_id || !job.summary) {
          setError('추천 근무표를 만들지 못했어요. 다시 계산해 주세요.')
          return
        }
        rememberHash(resultHash(job.result_id))
        const response = { data: { result_id: job.result_id, summary: job.summary } }
        const detail = await loadRosterResult(job.result_id)
        if (detail.status !== 'ok' || !detail.data) {
          setError(detail.message ?? '저장한 근무표를 불러오지 못했어요.')
          return
        }
        data = optionsFromStored(detail.data)
        setStored({ resultId: response.data.result_id, versionId: saved.versionId, summary: response.data.summary })
        summary = response.data.summary
      } else {
        const response = await planRosterOptions({ days, workers })
        if (response.status !== 'ok' || !response.data) {
          setError(response.message ?? '일주일 근무표를 만들지 못했어요.')
          return
        }
        data = response.data
      }
      for (const s of data.skipped_days) skip.push(`${WEEKDAY_LABEL[s.day as Weekday] ?? s.day}요일: ${s.reason}`)
      setShown(weekdays.filter((d) => d in data.days))
      setSkipped(skip)
      setChosen('RECOMMENDED')
      setOptions(data)
      onOptions?.(data, summary)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '일주일 근무표를 만들지 못했어요.')
    } finally {
      setStatus('')
    }
  }
  /** 고른 안을 공통 확정 API로 저장한다(저장한 계획에서 다시 볼 수 있음). 저장하면 그 안에 붙은 경고도 확인한 것으로 본다. */
  async function confirm(key: OptionKey) {
    if (!stored) return
    setError('')
    setStatus('고른 근무표를 저장하고 있어요')
    try {
      const warnings = stored.summary.warnings
        .filter((w) => w.choice_keys === null || w.choice_keys.includes(key))
        .map((w) => w.warning_id)
      await workflowApi.confirm(stored.resultId, stored.versionId, key, warnings, crypto.randomUUID())
      setConfirmed(key)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '저장하지 못했어요.')
    } finally {
      setStatus('')
    }
  }
  const lastAuto = useRef(autoRun)
  const makeRef = useRef(make)
  useEffect(() => {
    makeRef.current = make
  })
  useEffect(() => {
    if (autoRun === lastAuto.current) return
    lastAuto.current = autoRun
    void makeRef.current()
  }, [autoRun])
  // 모자란 알바를 명단에 더한 뒤 다시 만든다(명단이 바뀐 다음 렌더에서).
  const [again, setAgain] = useState(0)
  const lastAgain = useRef(0)
  useEffect(() => {
    if (again === lastAgain.current) return
    lastAgain.current = again
    void makeRef.current()
  }, [again])
  function addPeople(n: number) {
    const next = Math.max(0, ...people.map((p) => p.id))
    const extra: Person[] = Array.from({ length: n }, (_, i) => ({
      id: next + i + 1,
      name: `새 알바 ${people.length + i + 1}`,
      wage,
      minor: false,
      days: ALL_DAYS,
      start: open,
      end: close,
      maxHours: '14',
    }))
    setPeople([...people, ...extra].slice(0, MAX_PEOPLE))
    setAgain((k) => k + 1)
  }

  return (
    <section className="lab-card">
      <h2>5. 추천 근무표 (주 15시간 미만)</h2>
      <p className="lab-muted">
        요일마다 꼭 필요한 인원을 찾고, 바쁜 시간(최대 2구간)에만 1~3명을 더해 대기가 얼마나 줄어드는지 봐요. 그걸로 아끼는 안·추천안·여유
        안을 만들어 휴게까지 넣고, 모두 주 15시간 미만이 되게 아래 직원 명단에 배정해요. 하나를 골라 보세요. 저장하지 않는 미리보기예요.
      </p>

      {ownerWorking && (
        <div className="lab-row">
          <span className="opw-field-label">사장님 근무</span>
          {weekdays.map((d) => (
            <label key={d} className="lab-check">
              <input type="checkbox" checked={ownerDays.includes(d)} disabled={busy || disabled} onChange={() => setOwnerDays(toggle(ownerDays, d))} />
              {WEEKDAY_LABEL[d]}
            </label>
          ))}
          <label>
            시작
            <input type="time" step={1800} value={ownerStart} disabled={busy || disabled} onChange={(e) => setOwnerStart(e.target.value)} />
          </label>
          <label>
            끝
            <input type="time" step={1800} value={ownerEnd} disabled={busy || disabled} onChange={(e) => setOwnerEnd(e.target.value)} />
          </label>
        </div>
      )}

      <table className="lab-menus lab-people">
        <thead>
          <tr>
            <th>이름</th>
            <th>시급</th>
            <th>가능 요일</th>
            <th>가능 시간</th>
            <th>주 최대</th>
            <th>연소자</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {people.map((p) => (
            <tr key={p.id}>
              <td>
                <input value={p.name} disabled={busy} onChange={(e) => patch(p.id, { name: e.target.value })} />
              </td>
              <td>
                <input value={p.wage} inputMode="numeric" disabled={busy} onChange={(e) => patch(p.id, { wage: e.target.value.replace(/\D/g, '') })} />
              </td>
              <td className="lab-days">
                {WEEKDAYS.map((d) => (
                  <label key={d} className="lab-check">
                    <input type="checkbox" checked={p.days.includes(d)} disabled={busy} onChange={() => patch(p.id, { days: toggle(p.days, d) })} />
                    {WEEKDAY_LABEL[d]}
                  </label>
                ))}
              </td>
              <td>
                <input type="time" step={1800} value={p.start} disabled={busy} onChange={(e) => patch(p.id, { start: e.target.value })} />~
                <input type="time" step={1800} value={p.end} disabled={busy} onChange={(e) => patch(p.id, { end: e.target.value })} />
              </td>
              <td>
                <input value={p.maxHours} inputMode="numeric" disabled={busy} onChange={(e) => patch(p.id, { maxHours: e.target.value.replace(/\D/g, '') })} />
                시간
              </td>
              <td>
                <input type="checkbox" checked={p.minor} disabled={busy} onChange={() => patch(p.id, { minor: !p.minor })} aria-label={`${p.name} 연소자`} />
              </td>
              <td>
                <button type="button" className="button secondary" disabled={busy || people.length <= 1} onClick={() => setPeople(people.filter((x) => x.id !== p.id))}>
                  빼기
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="lab-row">
        <button
          type="button"
          className="button secondary"
          disabled={busy || people.length >= MAX_PEOPLE}
          onClick={() => setPeople([...people, { id: Math.max(0, ...people.map((p) => p.id)) + 1, name: `직원 ${people.length + 1}`, wage, minor: false, days: WEEKDAYS_ONLY, start: open, end: close, maxHours: '40' }])}
        >
          직원 추가
        </button>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setPeople(example(wage, open, close))}>
          예시 명단으로 되돌리기
        </button>
        <button
          type="button"
          className="button primary"
          disabled={busy || disabled || problems.length > 0 || Boolean(confirmed)}
          onClick={() => void make()}
        >
          추천 근무표 만들기
        </button>
      </div>
      {confirmed && (
        <p className="lab-muted">이 조건으로는 근무표를 이미 저장했어요. 다시 짜려면 위 2단계에서 다시 저장하고 계산해 주세요.</p>
      )}
      <p className="lab-muted">예시 명단은 시연용 가상 인물이에요. 이름·가능 시간·주 최대 근무시간을 바꿔 보세요.</p>
      {problems.length > 0 && (
        <ul className="lab-problems" role="alert">
          {problems.map((p) => (
            <li key={p} className="stop">
              {p}
            </li>
          ))}
        </ul>
      )}
      {status && (
        <p className="lab-status" role="status">
          {status}…
        </p>
      )}
      {error && (
        <p className="lab-error" role="alert">
          {error}
        </p>
      )}
      {skipped.length > 0 && (
        <ul className="lab-problems">
          {skipped.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      )}

      {options && (
        <OptionsView
          data={options}
          shown={shown}
          chosen={chosen}
          onChoose={setChosen}
          canAdd={!busy && !confirmed && people.length < MAX_PEOPLE}
          onAddPeople={addPeople}
          save={stored ? { summary: stored.summary, confirmed, busy, onConfirm: (key) => void confirm(key), link: resultHash(stored.resultId) } : undefined}
        />
      )}
    </section>
  )
}

/** 저장할 수 있을 때(업무가 있을 때) 넘기는 것. 없으면 미리보기. */
type SaveProps = { summary: RosterSummary; confirmed: OptionKey | null; busy: boolean; onConfirm: (key: OptionKey) => void; link?: string }

export function OptionsView({
  data,
  shown,
  chosen,
  onChoose,
  canAdd = false,
  onAddPeople,
  save,
}: {
  data: RosterOptions
  shown: Weekday[]
  chosen: OptionKey
  onChoose: (key: OptionKey) => void
  canAdd?: boolean
  onAddPeople?: (n: number) => void
  save?: SaveProps
}) {
  const option = data.options.find((o) => o.key === chosen) ?? data.options[0]
  const rec = data.options.find((o) => o.key === 'RECOMMENDED')!
  const holiday = data.holiday_compare.weekly
  const maxExtra = Math.max(...shown.map((d) => data.days[d].ladder.length - 1))
  const warnings = save
    ? save.summary.warnings.filter((w) => w.choice_keys === null || w.choice_keys.includes(option.key))
    : []
  return (
    <>
      {save && (
        <div className="lab-message" role="status">
          <p>
            <b>{save.summary.message}</b>
          </p>
          <small className="lab-muted">세 가지 안을 만들어 업무에 저장해 두었어요. 아래에서 하나를 골라 저장하면 "저장한 계획"에서 다시 볼 수 있어요.</small>
        </div>
      )}
      <h3>바쁜 시간에 사람을 더 쓰면 대기가 얼마나 줄까</h3>
      <p className="lab-muted">
        한가한 시간은 꼭 필요한 인원 그대로 두고 바쁜 시간에만 더했을 때, 바쁜 시간 중 가장 긴 대기예요(주문 후 받기, 10명 중 9명). 한 명
        더해 {Math.round(data.min_gain_sec)}초 넘게 줄면 추천안에 넣었어요. ● 추천, ○ 여유.
      </p>
      <div className="lab-scroll">
        <table className="lab-menus lab-ladder">
          <thead>
            <tr>
              <th>요일</th>
              <th>바쁜 시간</th>
              {Array.from({ length: maxExtra + 1 }, (_, k) => (
                <th key={k}>{k === 0 ? '꼭 필요한 인원' : `+${k}명`}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => {
              const day = data.days[d]
              return (
                <tr key={d}>
                  <td>{WEEKDAY_LABEL[d]}</td>
                  <td>{day.windows.map((w) => `${w.start_time}~${w.end_time}`).join(', ')}</td>
                  {Array.from({ length: maxExtra + 1 }, (_, k) => {
                    const step = day.ladder[k]
                    const prev = day.ladder[k - 1]
                    const cut = step && prev && step.peak_wait_sec != null && prev.peak_wait_sec != null ? prev.peak_wait_sec - step.peak_wait_sec : null
                    return (
                      <td key={k} className={day.picks.RECOMMENDED === k ? 'lab-pick' : ''}>
                        {step ? minutes(step.peak_wait_sec) : '—'}
                        {cut != null && <small> ({cut >= 6 ? `−${(cut / 60).toFixed(1)}` : '거의 그대로'})</small>}
                        {day.picks.RECOMMENDED === k && ' ●'}
                        {day.picks.ROOMY === k && day.picks.ROOMY !== day.picks.RECOMMENDED && ' ○'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="lab-compare lab-options">
        {data.options.map((o) => {
          const weekCost = o.plan_cost_krw
          const wait = avg(shown.map((d) => o.peak_wait_sec[d] ?? null))
          return (
            <button key={o.key} type="button" className={o.key === chosen ? 'lab-option chosen' : 'lab-option'} onClick={() => onChoose(o.key)}>
              <b>
                {o.title}
                {o.key === 'RECOMMENDED' && ' (추천)'}
              </b>
              <dl>
                <div>
                  <dt>바쁜 시간 대기(요일 평균)</dt>
                  <dd>{minutes(wait)}</dd>
                </div>
                <div>
                  <dt>주간 직원 인건비</dt>
                  <dd>{won(weekCost)}</dd>
                </div>
                <div>
                  <dt>일하는 알바</dt>
                  <dd>{o.weekly.people_used}명 (모두 주 15시간 미만)</dd>
                </div>
                <div>
                  <dt>못 채운 자리</dt>
                  <dd className={o.weekly.unfilled.length ? 'lab-error' : ''}>
                    {o.weekly.unfilled.length
                      ? `${o.shortfall.unfilled_hours}시간 · 알바 ${o.shortfall.more_people_under_15h}명 더 필요`
                      : '없음'}
                  </dd>
                </div>
              </dl>
              <small>{o.key === chosen ? '고른 안' : '이 안 보기'}</small>
            </button>
          )
        })}
      </div>
      <p className="lab-muted">
        추천안을 주휴를 주고 긴 근무조로 짜면 직원 {holiday.people_used}명, 주 {won(data.holiday_compare.plan_cost_krw)}(주휴수당{' '}
        {won(holiday.holiday_pay_krw)} 포함)이에요.{' '}
        {data.holiday_compare.plan_cost_krw >= rec.plan_cost_krw
          ? `주 15시간 미만으로 나누면 주 ${won(data.holiday_compare.plan_cost_krw - rec.plan_cost_krw)} 덜 들어요.`
          : `이 가게는 주휴를 주는 쪽이 주 ${won(rec.plan_cost_krw - data.holiday_compare.plan_cost_krw)} 덜 들어요. 짧은 조로 잘게 나누면 겹치는 시간이 생겨 유급 시간이 늘기 때문이에요(15시간 미만 안 ${rec.days ? Object.values(rec.days).reduce((t, d) => t + d.cost.employee_paid_hours, 0) : 0}시간 / 주휴 안 ${Object.values(data.holiday_compare.days).reduce((t, d) => t + d.cost.employee_paid_hours, 0)}시간).`}
        {holiday.unfilled.length > 0 && ' (주휴 안도 명단으로 다 못 채웠어요.)'}
      </p>

      {option.shortfall.more_people_under_15h > 0 && onAddPeople && (
        <div className="lab-warn">
          <b>
            {option.title}을 주 15시간 미만으로 채우려면 알바가 {option.shortfall.more_people_under_15h}명 더 필요해요(못 채운{' '}
            {option.shortfall.unfilled_hours}시간).
          </b>
          <p>지금 명단으로는 모자라요. 실제로 구할 수 있는 사람을 명단에 넣거나, 예시 알바를 넣어 다시 만들어 볼 수 있어요.</p>
          <button
            type="button"
            className="button secondary"
            disabled={!canAdd}
            onClick={() => onAddPeople(option.shortfall.more_people_under_15h)}
          >
            예시 알바 {option.shortfall.more_people_under_15h}명 넣고 다시 만들기
          </button>
        </div>
      )}

      {save && (
        <div className="lab-save">
          {save.confirmed ? (
            <p>
              <b>{data.options.find((o) => o.key === save.confirmed)?.title}을 저장했어요.</b> "저장한 계획"에서 다시 볼 수 있어요.
              {save.link && (
                <>
                  {' '}
                  <a
                    href={save.link}
                    onClick={(e) => {
                      // 주소가 이미 이 결과면 같은 주소라 이동이 안 일어나서, 다시 불러온다.
                      if (window.location.hash === save.link) {
                        e.preventDefault()
                        window.location.reload()
                      }
                    }}
                  >
                    이 근무표 다시 보기
                  </a>
                </>
              )}
            </p>
          ) : (
            <>
              <b>이대로 저장할까요?</b>
              <ul>
                <li>
                  {option.title} · 바쁜 시간 대기 {minutes(avg(shown.map((d) => option.peak_wait_sec[d] ?? null)))} · 주 인건비{' '}
                  {won(option.plan_cost_krw)} · 알바 {option.weekly.people_used}명(모두 주 15시간 미만)
                </li>
                {warnings.map((w) => (
                  <li key={w.warning_id} className="lab-muted">
                    {w.message}
                  </li>
                ))}
              </ul>
              <button type="button" className="button primary" disabled={save.busy} onClick={() => save.onConfirm(option.key)}>
                이 근무표로 저장
              </button>
              <small className="lab-muted"> 저장하면 위 안내를 확인한 것으로 봐요.</small>
            </>
          )}
        </div>
      )}

      <div className="lab-week">
        <h3>{option.title} 근무표</h3>
        <div className="lab-scroll">
          <table className="lab-menus">
            <thead>
              <tr>
                <th>직원</th>
                {shown.map((d) => (
                  <th key={d}>
                    {WEEKDAY_LABEL[d]}
                    {option.extra_by_day[d] > 0 && <small> 바쁠 때 +{option.extra_by_day[d]}</small>}
                  </th>
                ))}
                <th>주 근무</th>
                <th>주간 인건비</th>
              </tr>
            </thead>
            <tbody>
              {option.weekly.workers
                .filter((w) => w.days.length)
                .map((w) => (
                  <tr key={w.worker_key}>
                    <td>{w.name}</td>
                    {shown.map((d) => {
                      const a = option.weekly.assignments.find((x) => x.worker_key === w.worker_key && x.day === d)
                      return <td key={d}>{a ? `${a.start_time}~${a.end_time}` : ''}</td>
                    })}
                    <td>{w.weekly_work_hours}시간</td>
                    <td>{won(w.weekly_cost_krw)}</td>
                  </tr>
                ))}
              {option.weekly.unfilled.length > 0 && (
                <tr className="lab-need">
                  <td>못 채운 자리</td>
                  {shown.map((d) => (
                    <td key={d}>
                      {option.weekly.unfilled
                        .filter((u) => u.day === d)
                        .map((u) => `${u.start_time}~${u.end_time}`)
                        .join(', ')}
                    </td>
                  ))}
                  <td colSpan={2}>알바를 더 구하거나 가능 시간을 넓혀 주세요.</td>
                </tr>
              )}
              <tr>
                <td>하루 휴게</td>
                {shown.map((d) => (
                  <td key={d}>
                    <small>
                      {option.days[d].shifts
                        .filter((s) => !s.is_owner && s.breaks.length)
                        .map((s) => s.breaks.map((b) => `${b.start_time}~${b.end_time}`).join(', '))
                        .join(' / ') || '없음'}
                    </small>
                  </td>
                ))}
                <td colSpan={2}>
                  <small>근무 4시간 이상이면 30분 휴게(무급)</small>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
      <div className="lab-defaults">
        <b>계산 방식과 가정</b>
        <ul>
          {data.assumptions.map((a) => (
            <li key={a}>{a}</li>
          ))}
          <li>바쁜 시간은 요일마다 그 요일 데이터로 다시 정했어요(2단계에서 고친 바쁜 시간은 평균 하루에만 써요).</li>
        </ul>
      </div>
    </>
  )
}
