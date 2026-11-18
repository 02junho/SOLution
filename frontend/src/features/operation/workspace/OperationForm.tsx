import { useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Icon, Modal } from '../../../components/common/Ui'
import type { JsonObject } from '../../../types/workflow'
import {
  DAY_HOURS,
  FORM_MENUS,
  LAST_ORDER_TIMES,
  ORDER_PRESETS,
  HALF_HOURS,
  SLOT_KEYS,
  SLOT_SHARES,
  SLOW_RUN_ORDERS,
  digitsOnly,
  draftOperationInput,
  minimumWage,
  rushLength,
  rushText,
  formFromInput,
  problemsOf,
  slotCounts,
  slotLabel,
  wageProblem,
} from './operationInput'
import type { OperationFormValues } from './operationInput'
import './operationWorkspace.css'

/*
 * 운영 실험 조건 입력 (업무 화면 01 · 폼으로 직접 입력).
 * 사장님은 주문 수·라스트 오더·사장님 근무·시급만 고르고, 세 안의 근무표는 Spring(운영 입력 만들기)이 만든다.
 * 근무는 고정 가정(2명 07~19시, 11~14시에만 안이 바뀜). 잘못된 칸이 있으면 저장 버튼을 막고 버튼 옆에 이유를 보인다.
 */
const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export default function OperationForm({
  initial,
  busy,
  serverError,
  onSave,
  onClose,
}: {
  initial: JsonObject | null
  busy: boolean
  serverError: string
  onSave: (input: JsonObject) => Promise<boolean>
  onClose: () => void
}) {
  const [form, setForm] = useState<OperationFormValues>(() => formFromInput(initial))
  const [error, setError] = useState('')
  const [building, setBuilding] = useState(false)
  const problems = problemsOf(form)
  const wageError = wageProblem(form)
  const set = (patch: Partial<OperationFormValues>) => {
    setError('')
    setForm((f) => ({ ...f, ...patch }))
  }
  const orders = Number(form.dailyOrders) || 0
  const counts = slotCounts(form)
  const weightSum = form.menuIds.reduce((s, id) => s + (Number(form.weights[id]) || 0), 0)
  const rush = { start: form.rushStart, end: form.rushEnd }
  const rushOk = form.rushStart < form.rushEnd
  // 고른 바쁜 시간이 손님이 몰리는 11~14시와 절반 넘게 겹치는지(안 겹치면 안내만 하고 막지는 않는다).
  const overlapMinutes = Math.max(
    0,
    Math.min(toMinutes(form.rushEnd), 14 * 60) - Math.max(toMinutes(form.rushStart), 11 * 60),
  )
  const coversPeak = overlapMinutes >= 90

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (problems.length) return
    setError('')
    setBuilding(true)
    try {
      const draft = await draftOperationInput(form)
      if (await onSave(draft.input)) onClose()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '운영 조건을 만들지 못했어요.')
    } finally {
      setBuilding(false)
    }
  }

  const locked = busy || building
  return (
    <Modal
      title="운영 실험 조건 입력"
      description="현재 방식 · 서로 돕기 · 한 명 추가를 같은 손님 조건으로 비교해요."
      wide
      onClose={() => {
        if (!locked) onClose()
      }}
    >
      <form onSubmit={submit} className="condition-form operation-form">
        <fieldset disabled={locked}>
          <div className="opw-form-head">
            <strong>운영 실험 조건</strong>
            <p>
              모의 조건이에요. 가정에 근거한 값이라 실제 매장과 다를 수 있어요.
              <br />
              여기서는 조건만 저장하고, 세 안 중 하나를 고르는 건 계산이 끝난 뒤에 해요.
            </p>
          </div>
          {(error || serverError) && <Alert error>{error || serverError}</Alert>}

          <section className="form-section">
            <h3>01 · 하루 손님</h3>
            <div className="form-grid">
              <label>
                하루 주문 건수
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.dailyOrders}
                  placeholder="예) 150"
                  onChange={(e) => set({ dailyOrders: digitsOnly(e.target.value) })}
                />
              </label>
              <label>
                라스트 오더
                <select value={form.lastOrderTime} onChange={(e) => set({ lastOrderTime: e.target.value })}>
                  {LAST_ORDER_TIMES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                      {t === '18:45' ? ' (기본)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="opw-presets" role="group" aria-label="주문 건수 빠른 선택">
              {ORDER_PRESETS.map((p) => (
                <button
                  key={p.orders}
                  type="button"
                  className={`chip-button ${orders === p.orders ? 'active' : ''}`}
                  aria-pressed={orders === p.orders}
                  onClick={() => set({ dailyOrders: String(p.orders) })}
                >
                  {p.label}
                </button>
              ))}
              <span className="opw-info" tabIndex={0} role="note" aria-label="주문 건수 예시 설명">
                ⓘ
                <span className="opw-tip">
                  60·100·150건은 검증용 가상 조건(한산·보통·혼잡)이에요. 276건은 을지로입구 카페 상권의 점포당 하루 결제 건수
                  추정 중앙값이에요(카드 결제 기준). 시간대 비중은 서울시 상권분석서비스 자료를 써요.
                </span>
              </span>
            </div>
            <details className="opw-slot-details">
              <summary>시간대별 예상 주문 보기</summary>
              <table className="data-table compact opw-slot-table">
                <thead>
                  <tr>
                    <th>시간대</th>
                    <th>손님 비중</th>
                    <th>예상 주문</th>
                  </tr>
                </thead>
                <tbody>
                  {SLOT_KEYS.map((slot, i) => (
                    <tr key={slot}>
                      <td>{slotLabel(slot)}</td>
                      <td>{SLOT_SHARES[i].toFixed(1)}%</td>
                      <td>{counts[i]}건</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="opw-note">
                비중은 서울시 상권분석서비스의 을지로입구 커피 상권 카드결제 기준이에요(우리 매장 실제 주문 아님).
              </p>
            </details>
            <p className="opw-note">
              라스트 오더 뒤 손님은 받지 않고, 받은 주문은 끝까지 만들어요.
              {orders >= SLOW_RUN_ORDERS && ' 주문이 많으면 계산이 1분 넘게 걸릴 수 있어요.'}
            </p>
          </section>

          <section className="form-section">
            <h3>02 · 일하는 사람</h3>
            <div className="opw-choice-row" role="radiogroup" aria-label="사장님 근무 여부">
              <span className="opw-field-label">사장님도 매장에서 일하시나요?</span>
              <div className="opw-choice-buttons">
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.isOwnerWorking === true}
                  className={`chip-button ${form.isOwnerWorking === true ? 'active' : ''}`}
                  onClick={() => set({ isOwnerWorking: true })}
                >
                  네, 같이 일해요
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={form.isOwnerWorking === false}
                  className={`chip-button ${form.isOwnerWorking === false ? 'active' : ''}`}
                  onClick={() => set({ isOwnerWorking: false })}
                >
                  아니요, 직원만 일해요
                </button>
              </div>
              <small className={`opw-field-note ${form.isOwnerWorking === null ? 'opw-need' : ''}`}>
                {form.isOwnerWorking === null
                  ? '골라 주세요.'
                  : form.isOwnerWorking
                    ? '사장님이 주문·전달, 직원 1명이 제조를 맡아요. 사장님 근무는 인건비에서 빠져요.'
                    : '직원 2명이 주문·전달과 제조를 나눠 맡아요.'}
              </small>
            </div>
            <div className="opw-pair">
              <label className={`opw-field ${wageError ? 'opw-invalid' : ''}`}>
                <span className="opw-field-label">직원 시급 (원)</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.hourlyWage}
                  aria-invalid={Boolean(wageError)}
                  onChange={(e) => set({ hourlyWage: digitsOnly(e.target.value) })}
                />
                <small className="opw-field-note">
                  {wageError ??
                    (Number(form.hourlyWage) === minimumWage()
                      ? '현재 최저시급으로 채워 뒀어요.'
                      : `최저시급 ${(minimumWage() ?? 10_320).toLocaleString('ko-KR')}원 이상이면 돼요.`)}
                </small>
              </label>
              <div className="opw-field">
                <span className="opw-field-label">근무 시간 (고정)</span>
                <span className="opw-field-box">2명 모두 {DAY_HOURS}</span>
                <small className="opw-field-note">시간대별 인원 나누기는 다음 단계 기능이에요.</small>
              </div>
            </div>
          </section>

          <section className="form-section">
            <h3>03 · 비교할 세 안</h3>
            <div className="opw-plan-list">
              <div>
                <b>현재 방식</b>
                <span>주문·전달 1명, 제조 1명. 각자 맡은 일만 해요.</span>
              </div>
              <div>
                <b>서로 돕기</b>
                <span>사람과 시간은 그대로, 바쁜 시간{rushOk ? `(${rushText(rush)})` : ''}에만 서로의 일을 도와요.</span>
              </div>
              <div>
                <b>한 명 추가</b>
                <span>
                  바쁜 시간{rushOk ? `(${rushText(rush)})` : ''}에 제조를 맡고 주문도 돕는 직원 1명
                  {rushOk ? `(${rushLength(rush)})` : ''}을 더해요.
                </span>
              </div>
            </div>
            <div className="opw-pair">
              <label className={`opw-field ${rushOk ? '' : 'opw-invalid'}`}>
                <span className="opw-field-label">
                  바쁜 시간 시작{' '}
                  <span className="opw-info" tabIndex={0} role="note" aria-label="바쁜 시간 설명">
                    ⓘ
                    <span className="opw-tip">
                      손님이 가장 몰리는 시간은 공공데이터 기준 11:00~14:00(하루 손님의 절반)이에요. 바쁜 시간을 바꿔도
                      손님이 오는 시간은 그대로라, 이 시간과 겹치게 고르는 걸 권해요.
                    </span>
                  </span>
                </span>
                <select value={form.rushStart} onChange={(e) => set({ rushStart: e.target.value })}>
                  {HALF_HOURS.slice(0, -1).map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <small className="opw-field-note">사람을 더 넣거나 서로 도울 시간이에요.</small>
              </label>
              <label className={`opw-field ${rushOk ? '' : 'opw-invalid'}`}>
                <span className="opw-field-label">바쁜 시간 끝</span>
                <select value={form.rushEnd} onChange={(e) => set({ rushEnd: e.target.value })}>
                  {HALF_HOURS.slice(1).map((t) => (
                    <option key={t}>{t}</option>
                  ))}
                </select>
                <small className="opw-field-note">
                  {rushOk ? '휴게도 이 시간을 피해서 넣어요.' : '끝은 시작보다 늦게 골라 주세요.'}
                </small>
              </label>
            </div>
            {rushOk && !coversPeak && (
              <p className="opw-note opw-caution" role="status">
                고른 시간이 손님이 가장 몰리는 11:00~14:00과 많이 어긋나요. 바쁜 시간을 바꿔도 손님이 오는 시간은 그대로라
                효과가 작게 나올 수 있어요.
              </p>
            )}
          </section>

          <details className="form-section opw-details">
            <summary>
              자세히 설정 <span className="muted">처리시간 · 메뉴와 판매 비중</span>
            </summary>
            <div className="form-grid">
              <label>
                주문·결제 평균 (초)
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.orderSec}
                  onChange={(e) => set({ orderSec: digitsOnly(e.target.value) })}
                />
                <small>기본 60초 (가정)</small>
              </label>
              <label>
                음료 전달 평균 (초)
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.handoffSec}
                  onChange={(e) => set({ handoffSec: digitsOnly(e.target.value) })}
                />
                <small>기본 30초 (가정)</small>
              </label>
            </div>
            <div className="opw-menus">
              {FORM_MENUS.map((m) => (
                <label key={m.menu_id} className="opw-menu-card">
                  <span className="opw-menu-name">
                    <b>{m.menu_name}</b>
                    <small>
                      제조 {m.manufacture_sec}±{m.manufacture_stddev_sec}초
                    </small>
                  </span>
                  <span className="opw-menu-weight">
                    <input
                      type="text"
                      inputMode="numeric"
                      aria-label={`${m.menu_name} 판매 비중`}
                      value={form.weights[m.menu_id] ?? ''}
                      onChange={(e) => set({ weights: { ...form.weights, [m.menu_id]: digitsOnly(e.target.value) } })}
                    />
                    %
                  </span>
                </label>
              ))}
            </div>
            <p className={weightSum === 100 ? 'muted' : 'opw-warn'}>
              메뉴는 기본 5종이에요. 판매 비중 합계 {weightSum}% (100%가 되어야 해요). 처리시간은 실제 매장에서 잰 값이 아니라
              가정이에요.
            </p>
          </details>

          <section className="form-section">
            <h3>04 · 실험 방법</h3>
            <dl className="opw-method">
              <div>
                <dt>반복</dt>
                <dd>30회 (반복마다 손님 도착을 새로 뽑음)</dd>
              </div>
              <div>
                <dt>비교 방식</dt>
                <dd>같은 반복 안에서는 세 안이 같은 손님 조건 사용</dd>
              </div>
              <div>
                <dt>목표</dt>
                <dd>주문 후 받기까지 90%가 5분 이내, 30번 중 80% 이상 달성</dd>
              </div>
              <div>
                <dt>휴게</dt>
                <dd>대기 계산에는 넣지 않고 배치표에만 넣음 (바쁜 시간 피함)</dd>
              </div>
            </dl>
          </section>

          <div className="modal-footer opw-form-footer">
            {problems.length > 0 && (
              <ul className="opw-footer-problems" role="alert">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            )}
            <button type="button" className="button secondary" onClick={onClose}>
              취소
            </button>
            <button className="button primary" type="submit" disabled={problems.length > 0}>
              {locked ? '저장 중…' : '조건 저장하고 검토하기'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
