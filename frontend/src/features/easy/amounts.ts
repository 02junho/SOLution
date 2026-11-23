// 장보기 품목의 양을 사장님이 읽기 쉬운 말로: 2700g → 2.7kg, 10400ml → 10.4L, 130ea → 130개.
type Row = { item_name?: unknown; base_unit?: unknown; gross_need?: unknown; usable_inventory?: unknown }

const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const trim = (value: number) => Number(value.toFixed(2)).toLocaleString('ko-KR')

export function amountText(value: number, unit: string): string {
  if (unit === 'g') return value >= 1000 ? `${trim(value / 1000)}kg` : `${trim(value)}g`
  if (unit === 'ml') return value >= 1000 ? `${trim(value / 1000)}L` : `${trim(value)}ml`
  return `${trim(value)}개`
}

const rows = (items: unknown): Row[] => (Array.isArray(items) ? items.filter((item): item is Row => !!item && typeof item === 'object') : [])
const name = (row: Row) => (typeof row.item_name === 'string' && row.item_name ? row.item_name : null)

/** "원두 2.7kg · 우유 10.4L · 아이스컵 130개". 양을 모르는 품목은 "확인 필요"로 둔다(0으로 채우지 않는다). */
export function needLine(items: unknown): string {
  return rows(items)
    .filter(name)
    .map((row) => {
      const need = num(row.gross_need)
      return `${name(row)} ${need === null ? '확인 필요' : amountText(need, String(row.base_unit ?? ''))}`
    })
    .join(' · ')
}

/** 말로 바꾼 뒤 "무엇이 바뀌었는지" 비교할 품목별 값(쓸 양·지금 재고) */
export function itemFacts(items: unknown): Record<string, string> {
  const facts: Record<string, string> = {}
  for (const row of rows(items)) {
    const label = name(row)
    if (!label) continue
    const unit = String(row.base_unit ?? '')
    const need = num(row.gross_need)
    const stock = num(row.usable_inventory)
    facts[`${label} 쓸 양`] = need === null ? '확인 필요' : amountText(need, unit)
    facts[`${label} 재고`] = stock === null ? '확인 필요' : amountText(stock, unit)
  }
  return facts
}
