// 매입 "왜 이 안이에요?" 비교 계산. 화면 없이 숫자만 다뤄서 테스트할 수 있게 둔다.
// 비교 기준(baseline)은 AI 서버가 함께 계산한 "품목마다 단위가격이 가장 싼 견적만 고르기"다.
// 이 기준은 거래처 조건(배송 횟수·최소 주문·보관)을 보지 않아서 실제로는 주문이 안 될 수도 있다.
// 그래서 "얼마 아꼈다"고 하지 않고 "단가만 보면 얼마이고 무엇을 못 지키는지"로 보여 준다.

export type CompareLine = {
  item_id?: string
  item_name: string
  supplier_id: string
  supplier_name: string
  pack_size: number
  pack_count: number
  line_krw: number
}
export type BuyNeed = { item_id: string; buy_need: number; base_unit: string }
export type Baseline = { total_krw: number; lines: CompareLine[]; constraint_violations?: string[] }

export type Side = { krw: number; qty: number; packs: string; suppliers: string[] }
export type ItemRow = {
  key: string
  item: string
  need: number
  unit: string
  baseline: Side | null
  chosen: Side | null
  /** 이 품목만 보면 추천이 더 비싼데 그 이유(같은 곳에서 같이 사서 배송을 줄임) */
  pricierNote: string | null
  /** 단가만 보면 필요한 양보다 훨씬 많이(3배 이상) 사게 되는 품목 */
  overbuy: boolean
}

const VIOLATION: Record<string, string> = {
  budget: '예산을 넘어요',
  delivery_count: '배송이 너무 많아요',
  minimum_order: '최소 주문 금액을 못 채워요',
  storage: '보관할 자리를 넘어요',
  spoilage: '기한 안에 다 못 써요',
}

export function amount(value: number, unit: string) {
  if (unit === 'g') return value >= 1000 ? `${trim(value / 1000)}kg` : `${trim(value)}g`
  if (unit === 'ml') return value >= 1000 ? `${trim(value / 1000)}L` : `${trim(value)}ml`
  if (unit === 'ea') return `${value.toLocaleString('ko-KR')}개`
  return `${trim(value)}${unit}`
}
/** 받침에 맞는 조사(을/를, 은/는). 한글이 아니면 받침 없는 쪽. */
export function josa(word: string, withFinal: string, without: string) {
  const code = word.charCodeAt(word.length - 1) - 0xac00
  return word + (code >= 0 && code <= 11171 && code % 28 !== 0 ? withFinal : without)
}
const trim = (n: number) => String(Math.round(n * 10) / 10)

/** 묶음 표현: "100개 × 2", 1개면 "1,000개 1묶음" */
function packs(lines: CompareLine[], unit: string) {
  return lines.map((l) => (l.pack_count === 1 ? `${amount(l.pack_size, unit)} 1묶음` : `${amount(l.pack_size, unit)} × ${l.pack_count}`)).join(' + ')
}

function side(lines: CompareLine[], unit: string): Side | null {
  if (lines.length === 0) return null
  return {
    krw: lines.reduce((sum, l) => sum + l.line_krw, 0),
    qty: lines.reduce((sum, l) => sum + l.pack_size * l.pack_count, 0),
    packs: packs(lines, unit),
    suppliers: [...new Set(lines.map((l) => l.supplier_name))],
  }
}

const keyOf = (line: CompareLine) => line.item_id ?? line.item_name

export function compareItems(baseline: CompareLine[], chosen: CompareLine[], needs: BuyNeed[]): ItemRow[] {
  const order: string[] = []
  const names = new Map<string, string>()
  for (const line of [...chosen, ...baseline]) {
    const key = keyOf(line)
    if (!names.has(key)) { names.set(key, line.item_name); order.push(key) }
  }
  return order.map((key) => {
    const need = needs.find((n) => n.item_id === key)
    const unit = need?.base_unit ?? 'ea'
    const b = side(baseline.filter((l) => keyOf(l) === key), unit)
    const c = side(chosen.filter((l) => keyOf(l) === key), unit)
    const needQty = need?.buy_need ?? 0
    return {
      key,
      item: names.get(key) ?? key,
      need: needQty,
      unit,
      baseline: b,
      chosen: c,
      pricierNote: b && c && c.krw > b.krw ? `배송 횟수·최소 주문 같은 거래처 조건을 맞추려고 ${c.suppliers.join(', ')}에서 샀어요` : null,
      overbuy: Boolean(b && c && needQty > 0 && b.qty >= needQty * 3 && c.qty < b.qty),
    }
  })
}

/** 비교 기준이 못 지킨 조건을 사장님 말로. 배송은 실제 횟수를 넣는다. */
export function violationLabels(violations: string[], baselineDeliveries: number, maxDeliveries: number | null) {
  return violations.map((v) =>
    v === 'delivery_count' ? `배송 ${baselineDeliveries}번${maxDeliveries ? `(정한 건 ${maxDeliveries}번까지)` : ''}` : VIOLATION[v] ?? v,
  )
}

export function deliveriesOf(lines: CompareLine[]) {
  return new Set(lines.map((l) => l.supplier_id)).size
}

/** 한 줄 결론. 단가만 보면 상자째 사게 되는 품목이 있으면 그걸 먼저 말한다. */
export function compareSentence(rows: ItemRow[], chosenDeliveries: number) {
  const over = rows.filter((r) => r.overbuy).map((r) => r.item)
  const pricier = rows.filter((r) => r.pricierNote).map((r) => r.item)
  const parts: string[] = []
  if (over.length) parts.push(`단가만 보면 ${josa(over.join('·'), '을', '를')} 큰 상자째 사게 돼요. 필요한 만큼만 샀어요.`)
  if (pricier.length) parts.push(`${josa(pricier.join('·'), '은', '는')} 조금 비싸게 사는 대신 거래처 조건을 지키고 배송을 ${chosenDeliveries}번으로 줄여서 전체가 싸져요.`)
  return parts.join(' ')
}
