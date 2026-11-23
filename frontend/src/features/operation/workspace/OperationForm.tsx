import { useState } from 'react'
import type { FormEvent } from 'react'
import { Alert, Icon, Modal } from '../../../components/common/Ui'
import type { JsonObject } from '../../../types/workflow'
import {
  CLOSE_TIMES,
  DEFAULT_CLOSE,
  DEFAULT_OPEN,
  DEMO_STORE,
  FORM_MENUS,
  MENUS,
  OPEN_TIMES,
  ORDER_PRESETS,
  cupsTotal,
  defaultLastOrder,
  hoursOf,
  hoursText,
  lastOrderTimes,
  parseStoreData,
  PEAK,
  SLOT_KEYS,
  SLOT_SHARES,
  SLOW_RUN_ORDERS,
  digitsOnly,
  draftOperationInput,
  formInput,
  minimumWage,
  wageFloor,
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
 * 사장님은 주문 수·라스트 오더·사장님 근무·시급만 고르고, 폼 값만 저장한다. 세 안의 근무표는 계산할 때 Spring이 만든다.
 * 근무는 고정 가정(2명이 오픈~마감, 바쁜 시간에만 안이 바뀜). 바쁜 시간은 입력이 아니라 상권 데이터의 가장 바쁜 시간대다.
 * 가게 데이터 버전: 영업시간을 고르고, 가게 데이터(메뉴별 잔 수·제조시간)를 시연 데이터나 JSON 파일로 넣을 수 있다.
 * 잘못된 칸이 있으면 저장 버튼을 막고 버튼 옆에 이유를 보인다.
 */

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
  const hours = hoursOf(form)
  const defaultHours = hours.open === DEFAULT_OPEN && hours.close === DEFAULT_CLOSE
  const orders = form.store ? cupsTotal(form.store) : Number(form.dailyOrders) || 0
  const counts = slotCounts({ ...form, dailyOrders: String(orders) })
  const [storeError, setStoreError] = useState('')
  const loadStore = (raw: unknown) => {
    try {
      const { store, openTime, closeTime } = parseStoreData(raw)
      setStoreError('')
      // 데이터에 영업시간이 있으면 같이 넣고, 바뀐 마감에 맞지 않는 라스트 오더는 기본으로 되돌린다.
      const close = closeTime || form.closeTime || DEFAULT_CLOSE
      set({
        store,
        dailyOrders: String(cupsTotal(store)),
        ...(openTime ? { openTime } : {}),
        ...(closeTime ? { closeTime } : {}),
        ...(form.lastOrderTime && !lastOrderTimes(close).includes(form.lastOrderTime) ? { lastOrderTime: '' } : {}),
      })
    } catch (cause) {
      setStoreError(cause instanceof Error ? cause.message : '가게 데이터를 읽지 못했어요.')
    }
  }
  const readStoreFile = async (file: File | undefined) => {
    if (!file) return
    try {
      loadStore(JSON.parse(await file.text()))
    } catch {
      setStoreError('JSON 파일을 읽지 못했어요. 형식을 확인해 주세요.')
    }
  }
  const menuName = (id: string) => MENUS.find((m) => m.menu_id === id)?.menu_name ?? id
  const weightSum = form.menuIds.reduce((s, id) => s + (Number(form.weights[id]) || 0), 0)

  async function submit(e: FormEvent) {
    e.preventDefault()
    if (problems.length) return
    setError('')
    setBuilding(true)
    try {
      // 폼과 같은 규칙으로 한 번 더 검사하고(틀리면 이유를 보임), 저장은 폼 값만 한다.
      await draftOperationInput(form)
      if (await onSave(formInput(form))) onClose()
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
            <h3>01 · 영업시간과 하루 손님</h3>
            <div className="form-grid">
              <label>
                오픈
                <select value={form.openTime} onChange={(e) => set({ openTime: e.target.value })}>
                  <option value="">기본 ({DEFAULT_OPEN})</option>
                  {OPEN_TIMES.filter((t) => t !== DEFAULT_OPEN).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                마감
                <select
                  value={form.closeTime}
                  onChange={(e) => {
                    const close = e.target.value || DEFAULT_CLOSE
                    set({
                      closeTime: e.target.value,
                      ...(form.lastOrderTime && !lastOrderTimes(close).includes(form.lastOrderTime) ? { lastOrderTime: '' } : {}),
                    })
                  }}
                >
                  <option value="">기본 ({DEFAULT_CLOSE})</option>
                  {CLOSE_TIMES.filter((t) => t !== DEFAULT_CLOSE).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="form-grid">
              <label>
                하루 주문 건수
                <input
                  type="text"
                  inputMode="numeric"
                  value={form.store ? String(orders) : form.dailyOrders}
                  placeholder="예) 150"
                  disabled={Boolean(form.store)}
                  onChange={(e) => set({ dailyOrders: digitsOnly(e.target.value) })}
                />
                {form.store && <small>가게 데이터의 메뉴별 잔 수 합계예요.</small>}
              </label>
              <label>
                라스트 오더
                <select value={form.lastOrderTime} onChange={(e) => set({ lastOrderTime: e.target.value })}>
                  <option value="">기본 ({defaultLastOrder(hours.close)})</option>
                  {lastOrderTimes(hours.close).map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="opw-store" role="group" aria-label="가게 데이터">
              <span className="opw-field-label">가게 데이터 (선택)</span>
              {form.store ? (
                <>
                  <span>
                    메뉴 {Object.values(form.store.menu_cups ?? {}).filter((n) => n > 0).length}종 · 하루 {orders}잔
                    {form.store.manufacture_sec_by_menu &&
                      ` · 제조시간 ${Object.entries(form.store.manufacture_sec_by_menu)
                        .map(([id, sec]) => `${menuName(id)} ${sec}초`)
                        .join(', ')}`}
                  </span>
                  <button type="button" className="button secondary" onClick={() => set({ store: null })}>
                    가게 데이터 빼기
                  </button>
                </>
              ) : (
                <>
                  <button type="button" className="button secondary" onClick={() => loadStore(DEMO_STORE)}>
                    시연 데이터 넣기
                  </button>
                  <label className="button secondary">
                    JSON 불러오기
                    <input
                      type="file"
                      accept="application/json,.json"
                      hidden
                      onChange={(e) => {
                        void readStoreFile(e.target.files?.[0])
                        e.target.value = ''
                      }}
                    />
                  </label>
                </>
              )}
              {storeError && (
                <small className="opw-warn" role="alert">
                  {storeError}
                </small>
              )}
            </div>
            {!form.store && (
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
            )}
            {defaultHours ? (
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
            ) : (
              <p className="opw-note">
                영업 {hoursText(hours)}에 맞춰 시간대 비중을 계산할 때 다시 나눠요. 첫·마지막 시간대는 같은 상권 데이터에서 시간
                길이만큼 늘이거나 줄여요.
              </p>
            )}
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
                      : `최저시급 ${wageFloor().toLocaleString('ko-KR')}원 이상이면 돼요.`)}
                </small>
              </label>
              <div className="opw-field">
                <span className="opw-field-label">근무 시간 (영업시간)</span>
                <span className="opw-field-box">2명 모두 {hoursText(hours)}</span>
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
                <span>사람과 시간은 그대로, 바쁜 시간({rushText(PEAK)})에만 서로의 일을 도와요.</span>
              </div>
              <div>
                <b>한 명 추가</b>
                <span>
                  바쁜 시간({rushText(PEAK)})에 제조를 맡고 주문도 돕는 직원 1명({rushLength(PEAK)})을 더해요.
                </span>
              </div>
            </div>
            <p className="opw-note">
              바쁜 시간 {rushText(PEAK)}은 공공데이터(을지로입구 커피 상권)에서 1시간당 손님이 가장 많은 시간대예요. 휴게도
              이 시간을 피해서 넣어요. 우리 매장만의 바쁜 시간을 반영하는 건 다음 단계 기능이에요.
            </p>
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
            {form.store && (
              <p className="opw-note">가게 데이터가 들어 있어서 메뉴와 판매 비중은 메뉴별 잔 수로 계산해요. 아래 칸은 쓰지 않아요.</p>
            )}
            <p className={form.store || weightSum === 100 ? 'muted' : 'opw-warn'}>
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
