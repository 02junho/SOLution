// 쉬운 화면 테스트: 첫 마디로 매입(장보기)인지 운영(점심 인원)인지 고른다.
// 지금 AI 해석기(/agent/interpret)는 업무 종류가 정해진 뒤에만 쓰여서, 테스트 화면에서는 낱말로 가른다.
// 둘 다 아니거나 둘 다 많으면 null → 화면이 한 번 되묻는다.
export type EasyFeature = 'purchase' | 'operation'

const OPERATION_WORDS = ['점심', '알바', '직원', '인원', '사람', '근무', '배치', '대기', '줄이', '줄 ', '바빠', '바쁜', '손님', '시급', '한 명', '두 명', '교대', '운영']
const PURCHASE_WORDS = ['장보기', '장 보기', '매입', '견적', '원두', '우유', '컵', '뚜껑', '거래처', '재고', '예산', '배송', '구매', '발주', '사야', '살까', '주문할']

const count = (text: string, words: string[]) => words.filter((word) => text.includes(word)).length

export function guessFeature(text: string): EasyFeature | null {
  const normalized = ` ${text.replace(/\s+/g, ' ').trim()} `
  const operation = count(normalized, OPERATION_WORDS)
  const purchase = count(normalized, PURCHASE_WORDS)
  if (operation > purchase) return 'operation'
  if (purchase > operation) return 'purchase'
  return null
}

/** 손님 비율(0~1)을 "100명 중 몇 명"으로. 1명보다 적으면 그렇게 말한다. */
export function perHundred(ratio: number | null | undefined) {
  if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—'
  const people = ratio * 100
  if (people < 1) return '100명 중 1명도 안 돼요'
  return `100명 중 약 ${Math.round(people)}명`
}

type Segment = { worker_key: string; start_time: string; end_time: string; task_code: string }

const hour = (hhmm: string) => Number(hhmm.slice(0, 2)) + Number(hhmm.slice(3, 5)) / 60

/**
 * 추천 배치에서 지금 배치와 달라진 구간을 찾는다. 구간이 나뉘기만 하고 그 시간에 하는 일이 같으면 바뀐 것으로 보지 않는다.
 * 구간 가운데 시각에 같은 사람이 지금 배치에서 같은 일을 하고 있으면 그대로, 없거나 일이 다르면 바뀜.
 */
export function changedSegments(current: Segment[], next: Segment[]) {
  const changed = new Set<string>()
  for (const s of next) {
    const middle = (hour(s.start_time) + hour(s.end_time)) / 2
    const before = current.find((c) => c.worker_key === s.worker_key && hour(c.start_time) <= middle && middle < hour(c.end_time))
    if (!before || before.task_code !== s.task_code) changed.add(segmentKey(s))
  }
  return changed
}
export const segmentKey = (s: Segment) => `${s.worker_key}|${s.start_time}|${s.end_time}|${s.task_code}`
