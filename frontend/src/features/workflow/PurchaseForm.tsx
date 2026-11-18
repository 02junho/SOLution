import { useState } from 'react'
import type { FormEvent } from 'react'
import type { JsonObject } from '../../types/workflow'
import { object } from './model'
import { Modal, Alert, Icon } from '../../components/common/Ui'
import { purchaseExample } from './example'

type Row = JsonObject
const num = (value: string) => (value === '' ? null : Number(value))
const rows = (value: unknown): Row[] =>
  Array.isArray(value) ? value.map(object) : []

function NumberField({
  label,
  value,
  onChange,
  required = false,
  min = 0,
  integer = false,
}: {
  label: string
  value: unknown
  onChange: (value: number | null) => void
  required?: boolean
  min?: number
  integer?: boolean
}) {
  return (
    <label>
      {label}
      <input
        type="number"
        value={typeof value === 'number' ? value : ''}
        min={min}
        step={integer ? 1 : 'any'}
        required={required}
        onChange={(e) => onChange(num(e.target.value))}
        placeholder={required ? '입력해 주세요' : '모르면 비워 두세요'}
      />
    </label>
  )
}
export default function PurchaseForm({
  initial,
  busy,
  onSave,
  onClose,
  serverError,
}: {
  serverError: string
  initial: JsonObject | null
  busy: boolean
  onSave: (input: JsonObject) => Promise<boolean>
  onClose: () => void
}) {
  const [draft, setDraft] = useState<JsonObject>(() =>
    structuredClone(initial ?? { items: [], suppliers: [], quotes: [] }),
  )
  const [error, setError] = useState('')
  const items = rows(draft.items)
  const suppliers = rows(draft.suppliers)
  const quotes = rows(draft.quotes)
  function update(
    section: 'items' | 'suppliers' | 'quotes',
    index: number,
    patch: JsonObject,
  ) {
    setDraft((previous) => ({
      ...previous,
      [section]: rows(previous[section]).map((row, i) =>
        i === index ? { ...row, ...patch } : row,
      ),
    }))
  }
  function add(section: 'items' | 'suppliers' | 'quotes') {
    const row =
      section === 'items'
        ? { item_id: crypto.randomUUID(), item_name: '', base_unit: 'g' }
        : section === 'suppliers'
          ? { supplier_id: crypto.randomUUID(), supplier_name: '' }
          : {
              item_id: items[0]?.item_id ?? '',
              supplier_id: suppliers[0]?.supplier_id ?? '',
              pack_unit: items[0]?.base_unit ?? '',
              vat_included: null,
            }
    setDraft((previous) => ({
      ...previous,
      [section]: [...rows(previous[section]), row],
    }))
  }
  function remove(section: 'items' | 'suppliers' | 'quotes', index: number) {
    const deleted = rows(draft[section])[index]
    setDraft((previous) => ({
      ...previous,
      [section]: rows(previous[section]).filter((_, i) => i !== index),
      ...(section === 'items'
        ? {
            quotes: rows(previous.quotes).filter(
              (row) => row.item_id !== deleted.item_id,
            ),
          }
        : section === 'suppliers'
          ? {
              quotes: rows(previous.quotes).filter(
                (row) => row.supplier_id !== deleted.supplier_id,
              ),
            }
          : {}),
    }))
  }
  async function submit(e: FormEvent) {
    e.preventDefault()
    setError('')
    if (!items.length || !suppliers.length || !quotes.length) {
      setError('품목, 거래처, 견적을 각각 하나 이상 입력해 주세요.')
      return
    }
    if (
      items.some(
        (item) => !['g', 'ml', 'ea'].includes(String(item.base_unit ?? '')),
      )
    ) {
      setError('모든 품목의 기준 단위를 선택해 주세요.')
      return
    }
    if (
      quotes.some(
        (quote) =>
          !items.some(
            (item) =>
              item.item_id === quote.item_id &&
              item.base_unit === quote.pack_unit,
          ) ||
          !suppliers.some(
            (supplier) => supplier.supplier_id === quote.supplier_id,
          ),
      )
    ) {
      setError('견적의 품목·거래처·기준 단위를 다시 확인해 주세요.')
      return
    }
    if (await onSave(draft)) onClose()
  }
  return (
    <Modal
      title="계산할 조건 입력"
      description="알고 있는 값만 입력해 주세요. 입력 저장과 최종 계획 저장은 별도예요."
      wide
      onClose={() => {
        if (!busy) onClose()
      }}
    >
      <form onSubmit={submit} className="condition-form">
        <fieldset disabled={busy}>
          <div className="form-toolbar">
            <span className="eyebrow">매입·재고 조건</span>
            {/* 개발 확인용 버튼이라 사장님 화면에서는 숨긴다. 시연도 개발 서버로 하므로 DEV가 아니라
                VITE_SHOW_EXAMPLES=true일 때만 보인다 (예: VITE_SHOW_EXAMPLES=true npm run dev). */}
            {import.meta.env.VITE_SHOW_EXAMPLES === 'true' && (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setDraft(purchaseExample())
                  setError('')
                }}
              >
                합성 예제 불러오기
              </button>
            )}
          </div>
          {(error || serverError) && (
            <Alert error>{error || serverError}</Alert>
          )}
          <div className="form-grid">
            <NumberField
              label="예산 (원)"
              value={draft.budget_krw}
              required
              integer
              onChange={(v) => setDraft({ ...draft, budget_krw: v })}
            />
            <NumberField
              label="계획 기간 (일)"
              value={draft.planning_days}
              required
              integer
              min={1}
              onChange={(v) => setDraft({ ...draft, planning_days: v })}
            />
            <NumberField
              label="배송 횟수 상한"
              value={draft.max_delivery_count}
              required
              integer
              min={1}
              onChange={(v) => setDraft({ ...draft, max_delivery_count: v })}
            />
          </div>
          <section className="form-section">
            <h3>01 · 필요한 품목과 재고</h3>
            <p className="muted">
              필요 총량을 입력하세요. 재고는 계산할 때 한 번만 차감해요.
            </p>
            {items.map((row, i) => (
              <div className="form-row-card" key={String(row.item_id)}>
                <div className="row-heading">
                  <strong>품목 {i + 1}</strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`품목 ${i + 1} 삭제`}
                    onClick={() => remove('items', i)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    품목명
                    <input
                      required
                      value={String(row.item_name ?? '')}
                      onChange={(e) =>
                        update('items', i, { item_name: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    기준 단위
                    <select
                      value={String(row.base_unit ?? '')}
                      onChange={(e) => {
                        const unit = e.target.value
                        update('items', i, { base_unit: unit })
                        setDraft((previous) => ({
                          ...previous,
                          quotes: rows(previous.quotes).map((q) =>
                            q.item_id === row.item_id
                              ? { ...q, pack_unit: unit }
                              : q,
                          ),
                        }))
                      }}
                    >
                      <option value="">선택해 주세요</option>
                      <option value="g">g (그램)</option>
                      <option value="ml">ml (밀리리터)</option>
                      <option value="ea">개</option>
                    </select>
                  </label>
                  <NumberField
                    label="필요 총량"
                    value={row.gross_need}
                    required
                    onChange={(v) => update('items', i, { gross_need: v })}
                  />
                  <NumberField
                    label="사용 가능한 재고"
                    value={row.usable_inventory}
                    onChange={(v) =>
                      update('items', i, { usable_inventory: v })
                    }
                  />
                  <NumberField
                    label="남겨 둘 안전재고"
                    value={row.safety_stock}
                    required
                    onChange={(v) => update('items', i, { safety_stock: v })}
                  />
                  <NumberField
                    label="보관 한도 (선택)"
                    value={row.storage_capacity}
                    min={0.000001}
                    onChange={(v) =>
                      update('items', i, { storage_capacity: v })
                    }
                  />
                  <NumberField
                    label="기간 끝 재고 한도 (선택)"
                    value={row.max_end_inventory}
                    onChange={(v) =>
                      update('items', i, { max_end_inventory: v })
                    }
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              className="add-button"
              onClick={() => add('items')}
            >
              <Icon name="plus" size={16} />
              품목 추가
            </button>
          </section>
          <section className="form-section">
            <h3>02 · 거래처 조건</h3>
            {suppliers.map((row, i) => (
              <div className="form-row-card" key={String(row.supplier_id)}>
                <div className="row-heading">
                  <strong>거래처 {i + 1}</strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`거래처 ${i + 1} 삭제`}
                    onClick={() => remove('suppliers', i)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    거래처명
                    <input
                      required
                      value={String(row.supplier_name ?? '')}
                      onChange={(e) =>
                        update('suppliers', i, {
                          supplier_name: e.target.value,
                        })
                      }
                    />
                  </label>
                  <NumberField
                    label="최소 주문 금액 (원)"
                    value={row.minimum_order_krw}
                    required
                    integer
                    onChange={(v) =>
                      update('suppliers', i, { minimum_order_krw: v })
                    }
                  />
                  <NumberField
                    label="배송비 (원)"
                    value={row.delivery_fee_krw}
                    required
                    integer
                    onChange={(v) =>
                      update('suppliers', i, { delivery_fee_krw: v })
                    }
                  />
                  <NumberField
                    label="무료배송 기준 (선택)"
                    value={row.free_delivery_min_krw}
                    integer
                    onChange={(v) =>
                      update('suppliers', i, { free_delivery_min_krw: v })
                    }
                  />
                </div>
              </div>
            ))}
            <button
              type="button"
              className="add-button"
              onClick={() => add('suppliers')}
            >
              <Icon name="plus" size={16} />
              거래처 추가
            </button>
          </section>
          <section className="form-section">
            <h3>03 · 품목별 견적</h3>
            {quotes.map((row, i) => (
              <div className="form-row-card" key={i}>
                <div className="row-heading">
                  <strong>견적 {i + 1}</strong>
                  <button
                    type="button"
                    className="icon-button"
                    aria-label={`견적 ${i + 1} 삭제`}
                    onClick={() => remove('quotes', i)}
                  >
                    <Icon name="close" size={16} />
                  </button>
                </div>
                <div className="form-grid">
                  <label>
                    품목
                    <select
                      required
                      value={String(row.item_id ?? '')}
                      onChange={(e) => {
                        const item = items.find(
                          (v) => v.item_id === e.target.value,
                        )
                        update('quotes', i, {
                          item_id: e.target.value,
                          pack_unit: item?.base_unit ?? '',
                        })
                      }}
                    >
                      <option value="">선택해 주세요</option>
                      {items.map((item) => (
                        <option
                          key={String(item.item_id)}
                          value={String(item.item_id)}
                        >
                          {String(item.item_name || '이름 없는 품목')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    거래처
                    <select
                      required
                      value={String(row.supplier_id ?? '')}
                      onChange={(e) =>
                        update('quotes', i, { supplier_id: e.target.value })
                      }
                    >
                      <option value="">선택해 주세요</option>
                      {suppliers.map((supplier) => (
                        <option
                          key={String(supplier.supplier_id)}
                          value={String(supplier.supplier_id)}
                        >
                          {String(supplier.supplier_name || '이름 없는 거래처')}
                        </option>
                      ))}
                    </select>
                  </label>
                  <NumberField
                    label={`한 묶음의 양 (${String(row.pack_unit || '단위 선택 필요')})`}
                    required
                    min={0.000001}
                    value={row.pack_size}
                    onChange={(v) => update('quotes', i, { pack_size: v })}
                  />
                  <NumberField
                    label="묶음 가격 (원)"
                    required
                    integer
                    value={row.pack_price_krw}
                    onChange={(v) => update('quotes', i, { pack_price_krw: v })}
                  />
                  <label>
                    부가세
                    <select
                      value={
                        row.vat_included === true
                          ? 'true'
                          : row.vat_included === false
                            ? 'false'
                            : 'unknown'
                      }
                      onChange={(e) =>
                        update('quotes', i, {
                          vat_included:
                            e.target.value === 'unknown'
                              ? null
                              : e.target.value === 'true',
                        })
                      }
                    >
                      <option value="unknown">포함 여부 모름</option>
                      <option value="true">포함</option>
                      <option value="false">별도</option>
                    </select>
                  </label>
                </div>
              </div>
            ))}
            <button
              type="button"
              className="add-button"
              disabled={!items.length || !suppliers.length}
              onClick={() => add('quotes')}
            >
              <Icon name="plus" size={16} />
              견적 추가
            </button>
          </section>
          <div className="modal-footer">
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              취소
            </button>
            <button className="button primary" type="submit">
              {busy ? '저장 중…' : '조건 저장하고 검토하기'}
              <Icon name="arrow" size={16} />
            </button>
          </div>
        </fieldset>
      </form>
    </Modal>
  )
}
