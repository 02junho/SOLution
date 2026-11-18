import type { ReactNode } from 'react'
import type { Amount, Snapshot, Vat } from '../../types/purchasePreparation'

const format = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 6 })
const qty = (n: Amount, unit = '') =>
  n == null || !Number.isFinite(Number(n)) ? '미확인' : format.format(Number(n)) + unit
const unitLabel = (unit: string) => unit === 'each' ? '개' : unit
const vatLabel: Record<Vat, string> = { INCLUDED: '포함', EXCLUDED: '별도', UNKNOWN: '부가세 미확인' }

function Table({ name, headers, children }: { name: string; headers: string[]; children: ReactNode }) {
  return <div className="pp-table-wrap"><table aria-label={name}><thead><tr>
    {headers.map(h => <th key={h} scope="col">{h}</th>)}
  </tr></thead><tbody>{children}</tbody></table></div>
}
function Empty({ cols }: { cols: number }) {
  return <tr><td colSpan={cols} className="pp-empty">아직 표시할 데이터가 없어요.</td></tr>
}

export function SalesTable({ data }: { data: Snapshot['sales_plan'] }) {
  const rows = data.items
  return <section className="pp-card">
    <h2>이번 주 판매 계획</h2><p>최근 3일 실적과 사장님이 입력한 계획을 따로 표시해요.</p>
    <Table name="이번 주 판매 계획" headers={['메뉴', '최근 3일 실적', '이번 주 계획', '근거']}>
      {rows.map(r => <tr key={r.menu_id}><th scope="row">{r.menu_name}</th>
        <td>{qty(r.recent_3_day_quantity, '잔')}</td><td>{qty(r.quantity, '잔')}</td>
        <td>{r.source === 'OWNER_INPUT' ? '사장님 입력' : r.source || '미확인'}</td></tr>)}
      {!rows.length && <Empty cols={4} />}
    </Table>
  </section>
}
export function MaterialsTable({ data, refresh, busy }: {
  data: Snapshot['material_requirements']; refresh: () => void; busy: boolean
}) {
  return <section className="pp-card">
    <div className="pp-section-head"><div>
      <h2>재료 필요량과 재고</h2><p>단위는 g·ml·개. 살 양은 다음 단계에서 계산해요.</p>
    </div><button className="pp-plain" disabled={busy} onClick={refresh}>다시 계산</button></div>
    <Table name="재료 필요량과 재고" headers={['품목', '1잔 사용량', '총 필요량', '사용 가능 재고', '안전재고']}>
      {data.items.map(r => {
        const unit = unitLabel(r.unit)
        const usage = r.usage_per_serving
        const perServing = usage.length && usage.every(u => u.quantity === usage[0].quantity)
          ? qty(usage[0].quantity, unit) : null
        return <tr key={r.ingredient_id}><th scope="row">{r.ingredient_name}</th><td>
          {perServing && usage[0].menu_id === null ? `${perServing} (${qty(usage[0].planned_servings, '잔')})`
            : perServing || (usage.length ? usage.map(u => `${u.label}: ${qty(u.quantity, unit)}`).join(' / ') : '미확인')}
        </td><td>{qty(r.required_quantity, unit)}</td><td>{qty(r.available_inventory_quantity, unit)}</td>
          <td>{qty(r.safety_stock_quantity, unit)}</td></tr>
      })}
      {!data.items.length && <Empty cols={5} />}
    </Table>
  </section>
}

function shipping(r: Snapshot['quotes']['suppliers'][number]['shipping_rules'][number]) {
  const amount = r.fee_amount != null && Number(r.fee_amount) === 0 ? '무료' : qty(r.fee_amount, '원')
  const suffix = r.condition === 'BELOW' ? '미만' : r.condition === 'AT_LEAST' ? '이상' : ''
  if (suffix) return `${qty(r.threshold_amount, '원')} ${suffix} ${amount}`
  return r.condition === 'ALWAYS' ? amount : '배송 조건 미확인'
}
export function QuotesTable({ data, issues }: { data: Snapshot['quotes']; issues: Snapshot['issues'] }) {
  const suppliers = new Map(data.suppliers.map(s => [s.supplier_id, s]))
  const groups = new Map<string, typeof data.items>()
  for (const line of data.items) {
    const key = JSON.stringify([line.supplier_id, line.vat_status, line.display_group ?? null,
      line.display_group ? null : line.line_id])
    const group = groups.get(key) ?? []
    group.push(line)
    groups.set(key, group)
  }
  return <section className="pp-card">
    <h2>견적 정리</h2><p>거래처 {data.supplier_count}곳 · 원문은 대화에 남아 있어요.</p>
    <Table name="견적 정리" headers={['거래처', '품목 · 규격', '묶음 가격', '부가세', '배송 조건']}>
      {[...groups.entries()].map(([key, lines]) => {
        const first = lines[0]
        const supplier = suppliers.get(first.supplier_id)
        return <tr key={key}><th scope="row">{supplier?.supplier_name ?? '미확인'}</th>
          <td>{lines.map(l => <div key={l.line_id}>{l.item_name} {l.spec_text ?? '규격 미확인'}
            {!l.ingredient_id && <small className="pp-warn-text"> · 품목 확인 필요</small>}
          </div>)}</td>
          <td>{lines.map(l => <div key={l.line_id}>{qty(l.price_per_pack, '원')}</div>)}</td>
          <td><span className={`pp-chip ${first.vat_status === 'UNKNOWN' ? 'warn' : 'good'}`}>
            {vatLabel[first.vat_status] ?? '부가세 미확인'}</span></td>
          <td>{supplier?.shipping_rules.length ? supplier.shipping_rules.map(shipping).join(' / ') : '미확인'}</td>
        </tr>
      })}
      {!data.items.length && <Empty cols={5} />}
    </Table>
    {!!issues.length && <details className="pp-issues"><summary>확인할 항목 {issues.length}개</summary>
      <ul>{issues.map((issue, i) => <li key={`${issue.code}-${issue.target_id}-${i}`}>{issue.message}</li>)}</ul>
    </details>}
  </section>
}
