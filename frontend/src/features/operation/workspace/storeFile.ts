import catalog from './menu_catalog.json'
// 하루 주문 한도는 폼 검사와 같은 값 하나만 쓴다(따로 두면 한쪽만 바뀐다).
import { MAX_DAILY_ORDERS } from './operationInput'

/*
 * 가게 데이터 파일 읽기 (운영 2번: 가게 데이터 버전). 파일은 브라우저 안에서만 읽고, 정리한 숫자만 폼 값으로 저장한다.
 *
 * 받는 파일: CSV(UTF-8·EUC-KR, 쉼표·탭), 엑셀 xlsx. 첫 시트의 표에서 머리글 줄을 찾아 열 이름으로 칸을 맞춘다.
 *  - 결제 시각(승인일시·거래일시, 또는 날짜+시간 두 열) → 1시간 단위 시간대별 주문 수, 영업시간, 바쁜 시간
 *  - 메뉴(품목·상품명)+수량 → 메뉴별 잔 수(판매 비중)
 *  - 상태(취소·환불)·음수 금액 → 취소로 빼고, 같은 줄이 두 번 있으면 중복으로 뺀다
 * 가정: 주문 1건 = 음료 1잔(엔진과 같음). 메뉴 열이 있으면 수량을 잔 수로, 없으면 결제 1건을 1잔으로 센다.
 * 열 이름 목록은 화면 문구가 아니라 흔한 내보내기 파일의 머리글 이름(데이터)이다.
 */

export type Cell = string | number | boolean | Date | null
export type Table = Cell[][]
export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const
export type Weekday = (typeof WEEKDAYS)[number]
export const WEEKDAY_LABEL: Record<Weekday, string> = {
  MON: '월',
  TUE: '화',
  WED: '수',
  THU: '목',
  FRI: '금',
  SAT: '토',
  SUN: '일',
}
/** 계산할 하루: 평균 하루 또는 한 요일의 평균. */
export type DayBasis = 'AVERAGE' | Weekday

export const PEAK_HOURS = 3
/** 하루 평균 이 건수 이상 주문이 있는 시간을 영업시간으로 본다(가끔 있는 오픈 전·마감 후 결제는 뺀다). */
const ACTIVE_HOURLY_MIN = 0.5
const STORE_OPEN_MIN = 5
const STORE_CLOSE_MAX = 23
const STORE_MIN_HOURS = 4

// ---------------------------------------------------------------- 파일 → 표
export async function readTable(file: File): Promise<Table> {
  const name = file.name.toLowerCase()
  if (name.endsWith('.xls')) throw new Error('예전 엑셀(.xls)은 읽지 못해요. 엑셀에서 xlsx나 CSV로 저장해서 올려 주세요.')
  if (name.endsWith('.xlsx')) {
    try {
      // 엑셀 읽기 라이브러리는 xlsx를 올릴 때만 불러온다(첫 화면 번들에 넣지 않음).
      const { readSheet } = await import('read-excel-file/universal')
      return (await readSheet(await file.arrayBuffer())) as Table
    } catch {
      throw new Error('엑셀 파일을 읽지 못했어요. 첫 시트에 표가 있는지 확인해 주세요.')
    }
  }
  return parseCsv(decodeText(await file.arrayBuffer()))
}

/** UTF-8로 읽고, 깨지면 EUC-KR(CP949)로 다시 읽는다. 국내 서비스 CSV는 EUC-KR이 많다. */
export function decodeText(buffer: ArrayBuffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer).replace(/^﻿/, '')
  } catch {
    return new TextDecoder('euc-kr').decode(buffer)
  }
}

/** 따옴표 밖에 있는 글자 ch의 수(따옴표 안 쉼표는 칸 구분이 아니다). */
function countOutsideQuotes(line: string, ch: string): number {
  let quoted = false
  let n = 0
  for (const c of line) {
    if (c === '"') quoted = !quoted
    else if (!quoted && c === ch) n++
  }
  return n
}

/** 머리글을 찾아볼 앞쪽 줄 수(analyzeTable이 머리글을 찾는 범위와 같게). */
const HEADER_SCAN_ROWS = 20

/**
 * 칸 구분자: 앞쪽 줄들 가운데 따옴표 밖 구분자가 가장 많은 줄(표 머리글 후보)을 보고, 탭이 쉼표보다 많으면 탭.
 * 첫 줄이 "조회 기간: …" 같은 설명이어도 그 아래 머리글로 정한다.
 */
function countSeparators(text: string): '\t' | ',' {
  let tabs = 0
  let commas = 0
  for (const line of text.split(/\r?\n/, HEADER_SCAN_ROWS)) {
    tabs = Math.max(tabs, countOutsideQuotes(line, '\t'))
    commas = Math.max(commas, countOutsideQuotes(line, ','))
  }
  return tabs > commas ? '\t' : ','
}

/** 앞쪽 줄에서 알아본 머리글 열 수의 최댓값(구분자 고르기용). */
const knownColumns = (rows: Table) =>
  Math.max(0, ...rows.slice(0, HEADER_SCAN_ROWS).map((r) => Object.keys(findColumns(r)).length))

/**
 * CSV(따옴표·줄바꿈 포함 칸 처리). 탭·쉼표 두 가지로 나눠 보고 머리글 열을 더 많이 알아본 쪽을 쓴다.
 * 같으면 앞쪽 줄의 구분자 개수로 정한다(탭 파일의 금액 "4,500" 쉼표나 설명 줄에 끌려가지 않게).
 */
export function parseCsv(text: string): Table {
  const tab = splitCsv(text, '\t')
  const comma = splitCsv(text, ',')
  const [a, b] = [knownColumns(tab), knownColumns(comma)]
  if (a !== b) return a > b ? tab : comma
  return countSeparators(text) === '\t' ? tab : comma
}

function splitCsv(text: string, sep: '\t' | ','): Table {
  const rows: Table = []
  let row: Cell[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"'
        i++
      } else if (ch === '"') quoted = false
      else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === sep) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows.filter((r) => r.some((c) => String(c ?? '').trim() !== ''))
}

// ---------------------------------------------------------------- 머리글 → 칸
const squash = (v: unknown) => String(v ?? '').toLowerCase().replace(/[\s_\-()[\]·./]/g, '')
// 흔한 내보내기 파일의 머리글 이름. 앞에 있는 것부터 찾는다.
const HEADERS = {
  datetime: ['승인일시', '거래일시', '결제일시', '주문일시', '판매일시', '매출일시', '일시', 'datetime', 'timestamp'],
  date: ['승인일자', '거래일자', '결제일자', '주문일자', '판매일자', '매출일자', '일자', '날짜', '승인일', '거래일', '결제일', 'date'],
  time: ['승인시간', '거래시간', '결제시간', '주문시간', '판매시간', '승인시각', '거래시각', '결제시각', '시간', '시각', 'time'],
  status: ['승인구분', '거래구분', '결제구분', '거래상태', '승인상태', '상태', '구분', 'status'],
  // 예/아니오로 적는 취소 열. 상태 열과 따로 찾아 둘 다 본다.
  cancel: ['취소여부', '취소유무', 'cancelled', 'canceled', 'iscancel'],
  // 같은 거래를 알아볼 번호. 있을 때만 똑같은 줄을 중복으로 뺀다.
  id: ['승인번호', '거래번호', '주문번호', '영수증번호', 'transactionid', 'orderid', 'approvalno'],
  amount: ['승인금액', '결제금액', '거래금액', '판매금액', '매출금액', '금액', '합계', 'amount'],
  menu: ['메뉴명', '상품명', '품목명', '메뉴', '상품', '품목', 'item', 'product', 'menu'],
  qty: ['수량', '판매수량', '개수', 'qty', 'quantity'],
} as const
type Field = keyof typeof HEADERS
type Columns = Partial<Record<Field, number>>

function findColumns(header: Cell[]): Columns {
  const names = header.map(squash)
  const used = new Set<number>()
  const cols: Columns = {}
  // 1차: 모든 칸을 정확한 이름으로 먼저 잡는다(앞 칸의 부분 일치가 뒤 칸의 정확한 머리글을 가져가지 않게)
  // 2차: 못 찾은 칸만 부분 일치로 찾는다.
  for (const match of [(n: string, key: string) => n === key, (n: string, key: string) => n.includes(key)]) {
    for (const field of Object.keys(HEADERS) as Field[]) {
      if (cols[field] !== undefined) continue
      for (const key of HEADERS[field]) {
        const at = names.findIndex((n, i) => !used.has(i) && match(n, key))
        if (at >= 0) {
          cols[field] = at
          used.add(at)
          break
        }
      }
    }
  }
  return cols
}

const score = (c: Columns) =>
  (c.datetime !== undefined || (c.date !== undefined && c.time !== undefined) ? 2 : 0) + (c.menu !== undefined ? 1 : 0)

// ---------------------------------------------------------------- 날짜·시각 읽기
const pad = (n: number) => String(n).padStart(2, '0')
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`

/** 엑셀 날짜 일련번호(1900 체계) → [날짜, 하루 중 분]. */
function fromSerial(n: number): [string | null, number | null] {
  const days = Math.floor(n)
  // 초가 있으면 그 분에 둔다(08:59:45가 9시 칸으로 넘어가지 않게). 09:00이 8:59.9999로 읽히는 오차만 보정한다.
  const minutes = Math.floor((n - days) * 1440 + 1e-6) % 1440
  if (days < 1) return [null, minutes]
  const date = new Date(Date.UTC(1899, 11, 30) + days * 86_400_000)
  return [ymd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()), minutes]
}

function readDate(v: Cell): string | null {
  if (v instanceof Date) return ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate())
  if (typeof v === 'number') return v > 20_000_000 ? readDate(String(v)) : fromSerial(v)[0]
  const text = String(v ?? '').trim()
  const m = text.match(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})/) ?? text.match(/^(\d{4})(\d{2})(\d{2})/)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  // 달력에 없는 날(2월 31일 등)은 읽지 못한 줄로 둔다
  const real = new Date(Date.UTC(y, mo - 1, d))
  return real.getUTCFullYear() === y && real.getUTCMonth() === mo - 1 && real.getUTCDate() === d ? ymd(y, mo, d) : null
}

function readMinute(v: Cell): number | null {
  if (v instanceof Date) return v.getUTCHours() * 60 + v.getUTCMinutes()
  if (typeof v === 'number') {
    if (v < 0) return null
    // 정수 0~2359는 HHMM(1430 = 14:30), 정수 2400~235959는 HHMMSS(93000 = 09:30:00).
    // 소수는 엑셀 날짜·시각 일련번호. 정수 일련번호(날짜만)는 시각이 없어(0시) 시각 칸으로 쓸 일이 없다.
    if (Number.isInteger(v) && v < 2400) return v % 100 < 60 ? Math.floor(v / 100) * 60 + (v % 100) : null
    if (Number.isInteger(v) && v < 240000) {
      const [h, m, sec] = [Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100]
      return m < 60 && sec < 60 ? h * 60 + m : null
    }
    return fromSerial(v)[1]
  }
  const text = String(v ?? '').trim()
  // 날짜 뒤에 붙은 시각(2026-11-03 14:30:15), 또는 시각만(14:30, 오후 2:30, 143015)
  const rest = text.replace(/(\d{4})\s*[-./년]\s*(\d{1,2})\s*[-./월]\s*(\d{1,2})\s*일?/, ' ').trim()
  const m = rest.match(/(오전|오후|AM|PM|am|pm)?\s*(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM|am|pm)?/)
  if (m) {
    let h = Number(m[2])
    const mm = Number(m[3])
    const half = (m[1] ?? m[4] ?? '').toLowerCase()
    if ((half === '오후' || half === 'pm') && h < 12) h += 12
    if ((half === '오전' || half === 'am') && h === 12) h = 0
    return h < 24 && mm < 60 ? h * 60 + mm : null
  }
  const digits = rest.match(/^(\d{2})(\d{2})(\d{2})?$/)
  if (digits && Number(digits[1]) < 24 && Number(digits[2]) < 60) return Number(digits[1]) * 60 + Number(digits[2])
  return null
}

// ---------------------------------------------------------------- 메뉴 이름 맞추기
const tempWords: [RegExp, string][] = [
  [/아이스|iced|ice|\(i\)|차가운/g, 'ice'],
  [/핫|hot|\(h\)|따뜻한|뜨거운/g, 'hot'],
]
/** 이름을 비교용으로 다듬는다. 온도(아이스·핫)는 앞뒤 어디에 있어도 같은 낱말로 본다. */
export function menuKey(name: string): string {
  let text = name.toLowerCase()
  const temps: string[] = []
  for (const [re, word] of tempWords) {
    re.lastIndex = 0
    if (re.test(text)) temps.push(word)
    text = text.replace(re, ' ')
  }
  return [...new Set(temps)].sort().join('') + squash(text)
}
export const CATALOG_MENUS = catalog.menus.map((m) => ({ id: m.menu_id, name: m.menu_name }))
const BY_KEY = new Map(
  CATALOG_MENUS.flatMap((m) => [
    [menuKey(m.name), m.id],
    [menuKey(m.id.replaceAll('_', ' ')), m.id],
  ]),
)
export const matchMenu = (name: string): string | null => BY_KEY.get(menuKey(name)) ?? null

// ---------------------------------------------------------------- 메뉴 유형(제조 방식) 알아보기
/*
 * 카탈로그 10종은 "제조 방식 틀"로 쓴다. 파일 메뉴 이름이 무엇이든 낱말로 제조 방식(기계·우유·블렌더·온도)을 알아보고
 * 가장 가까운 틀의 제조 단계와 시간을 빌린다. 메뉴 이름 목록을 늘리는 게 아니라 낱말 → 유형 규칙이라 처음 보는 메뉴도 된다.
 */
export type MenuHow = 'EXACT' | 'KEYWORD' | 'FOOD' | 'AI' | 'GUESS'
type TypeRule = { re: RegExp; ice: string | null; hot: string | null; label: string }
/** 위에서부터 먼저 걸리는 규칙을 쓴다(예: 말차 프라페 → 블렌더, 바닐라라떼 → 시럽 라떼). */
const TYPE_RULES: TypeRule[] = [
  {
    re: /케이크|케익|쿠키|베이글|샌드위치|빵|크로플|와플|마카롱|스콘|휘낭시에|마들렌|디저트|브라우니|타르트|토스트|샐러드|티라미수|파이|도넛|도너츠|원두|드립백|텀블러|머그|굿즈|쿠폰|상품권|봉투|cake|cookie|bagel/,
    ice: null,
    hot: null,
    label: '음료 아님',
  },
  { re: /스무디|프라페|프라푸치노|쉐이크|셰이크|블렌디드|빙수|smoothie|frappe|shake/, ice: 'blueberry_yogurt_smoothie', hot: 'blueberry_yogurt_smoothie', label: '블렌더 음료' },
  { re: /밀크티|차이|로얄|milktea/, ice: 'iced_milk_tea', hot: 'hot_cafe_latte', label: '밀크티' },
  { re: /초코|초콜릿|쇼콜라|코코아|choco|cocoa/, ice: 'iced_choco_latte', hot: 'hot_cafe_latte', label: '초코 음료' },
  { re: /녹차|말차|그린티|곡물|미숫가루|고구마|흑임자|딸기라떼|딸기우유|우유|matcha|greentea/, ice: 'iced_green_tea_latte', hot: 'hot_cafe_latte', label: '커피 없는 라떼' },
  { re: /바닐라|카라멜|캐러멜|헤이즐넛|돌체|모카|아인슈페너|연유|마끼아또|마키아토|vanilla|caramel|mocha/, ice: 'iced_vanilla_latte', hot: 'hot_cafe_latte', label: '시럽 넣은 우유 커피' },
  { re: /라떼|라테|카푸치노|플랫화이트|코르타도|latte|cappuccino|flatwhite/, ice: 'iced_cafe_latte', hot: 'hot_cafe_latte', label: '우유 커피' },
  { re: /에이드|레모네이드|아이스티|주스|쥬스|스파클링|소다|탄산|자몽|유자|레몬|청귤|티|차|ade|juice|tea|soda/, ice: 'iced_lemon_ade', hot: 'iced_lemon_ade', label: '기계 없이 만드는 음료' },
  { re: /아메리카노|에스프레소|커피|콜드브루|드립|롱블랙|디카페인|americano|espresso|coffee|coldbrew/, ice: 'iced_americano', hot: 'hot_americano', label: '커피' },
]
/** 화면에서 고르는 유형(틀). 이름은 제조 방식으로 보여 준다. */
export const MENU_TYPES: { id: string; label: string }[] = [
  { id: 'iced_americano', label: '커피 · 아이스' },
  { id: 'hot_americano', label: '커피 · 따뜻한' },
  { id: 'iced_cafe_latte', label: '우유 커피 · 아이스' },
  { id: 'iced_vanilla_latte', label: '시럽 넣은 우유 커피 · 아이스' },
  { id: 'hot_cafe_latte', label: '따뜻한 우유 음료(라떼류)' },
  { id: 'iced_green_tea_latte', label: '커피 없는 라떼 · 아이스(녹차·곡물 등)' },
  { id: 'iced_choco_latte', label: '초코 음료 · 아이스' },
  { id: 'iced_milk_tea', label: '밀크티 · 아이스' },
  { id: 'iced_lemon_ade', label: '기계 없이 만드는 음료(에이드·티·주스)' },
  { id: 'blueberry_yogurt_smoothie', label: '블렌더 음료(스무디·프라페)' },
]
export const typeLabel = (id: string) => MENU_TYPES.find((t) => t.id === id)?.label ?? id
export const typeSeconds = (id: string) => catalog.menus.find((m) => m.menu_id === id)?.manufacture_sec ?? null

/**
 * 메뉴 이름 → 제조 유형. EXACT: 카탈로그 메뉴와 같은 이름, KEYWORD: 낱말로 알아봄(추정), FOOD: 음료 아님(빼고 계산),
 * null: 이름으로는 모름(AI에 묻거나 가장 많이 팔린 유형으로 채운다).
 */
export function classifyMenu(name: string): { menuId: string | null; how: MenuHow } | null {
  const exact = matchMenu(name)
  if (exact) return { menuId: exact, how: 'EXACT' }
  const key = menuKey(name)
  const hot = key.startsWith('hot') && !key.startsWith('hotice')
  const text = key.replace(/^(hot|ice)+/, '')
  for (const rule of TYPE_RULES) {
    if (!rule.re.test(text)) continue
    if (rule.ice === null) return { menuId: null, how: 'FOOD' }
    // 온도가 없으면 아이스로 본다(추정 표시, 고칠 수 있음).
    return { menuId: hot ? rule.hot : rule.ice, how: 'KEYWORD' }
  }
  return null
}

// ---------------------------------------------------------------- 표 → 날짜별 집계
/** hours: 시간(0~23시)별 주문 수, menus: 메뉴별 하루 잔 수, hourMenus: 시간별 메뉴 잔 수(빼는 메뉴·영업시간 밖을 시간마다 덜어 내려고) */
export type DayCounts = { hours: number[]; menus: Record<string, number>; hourMenus: Record<string, number>[] }
export type StoreImport = {
  fileName: string
  rowsRead: number
  excluded: { cancelled: number; unreadable: number; duplicate: number }
  /** 중복으로 빼지 않았지만 다른 줄과 똑같은 줄 수(거래 번호도 초 단위 시각도 없어 같은 분의 다른 주문일 수 있음). 화면 안내용 */
  sameRows: number
  hasTime: boolean
  hasMenu: boolean
  /** 날짜 → 시간(0~23시)별 주문 수, 파일 메뉴 이름별 잔 수 */
  byDate: Record<string, DayCounts>
  /** 시각이 없는 파일의 메뉴 합계(날짜만 있거나 아무것도 없을 때) */
  undated: Record<string, number>
  columns: Partial<Record<Field, string>>
}

/** 시각 칸에 초가 들어 있는지(09:10:37, 091037, 초가 있는 엑셀 시각). 초가 0인 값은 분 단위와 구분할 수 없어 보지 않는다. */
function hasSeconds(v: Cell): boolean {
  if (v instanceof Date) return v.getUTCSeconds() !== 0
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return v >= 2400 && v < 240000 && v % 100 !== 0
    const sec = Math.round((v - Math.floor(v)) * 86400) % 60
    return sec !== 0
  }
  const m = String(v ?? '').match(/\d{1,2}:\d{2}:(\d{2})/) ?? String(v ?? '').trim().match(/^\d{4}(\d{2})$/)
  return Boolean(m && m[1] !== '00')
}

/** "취소여부"처럼 예/아니오로 적는 열이면 Y·예·1·true가 취소다. */
const YES = /^(y|yes|예|o|1|true)$/i
/** 상태 글자에 "취소"가 있어도 취소가 아니라는 말(미취소·취소 없음 등) */
const NOT_CANCELLED = /미취소|비취소|취소\s*(없음|아님|안\s*함)|not\s*cancel|uncancel/i
const isCancelled = (status: Cell, cancelFlag: Cell, amount: Cell) => {
  const text = String(status ?? '')
  return (
    (/취소|환불|반품|cancel|refund/i.test(text) && !NOT_CANCELLED.test(text)) ||
    YES.test(String(cancelFlag ?? '').trim()) ||
    (typeof amount === 'number' ? amount < 0 : /^\s*-\s*\d/.test(String(amount ?? '')))
  )
}

/** 메뉴 이름을 키로 쓰는 집계: 프로토타입이 없어 "constructor" 같은 메뉴 이름도 그대로 센다. */
const tally = <T,>(): Record<string, T> => Object.create(null) as Record<string, T>
/** 자기 키만 본다("toString" 같은 상속 이름을 값으로 착각하지 않게). */
const own = <T,>(rec: Record<string, T>, key: string): T | undefined => (Object.hasOwn(rec, key) ? rec[key] : undefined)

export function analyzeTable(table: Table, fileName: string): StoreImport {
  let headerAt = -1
  let cols: Columns = {}
  for (let i = 0; i < Math.min(table.length, 20); i++) {
    const found = findColumns(table[i])
    if (score(found) > score(cols)) {
      cols = found
      headerAt = i
    }
  }
  const hasTime = cols.datetime !== undefined || (cols.date !== undefined && cols.time !== undefined)
  const hasMenu = cols.menu !== undefined
  if (headerAt < 0 || (!hasTime && !hasMenu)) {
    throw new Error('결제 시각(승인일시·거래일시)이나 메뉴(품목·상품명) 열을 찾지 못했어요. 첫 줄에 열 이름이 있는지 확인해 주세요.')
  }
  const header = table[headerAt]
  const out: StoreImport = {
    fileName,
    rowsRead: 0,
    excluded: { cancelled: 0, unreadable: 0, duplicate: 0 },
    sameRows: 0,
    hasTime,
    hasMenu,
    byDate: tally<DayCounts>(),
    undated: tally<number>(),
    columns: Object.fromEntries(Object.entries(cols).map(([k, i]) => [k, String(header[i as number] ?? '')])),
  }
  const rows = table.slice(headerAt + 1)
  // 똑같은 줄을 중복으로 빼는 경우: 거래 번호 열이 있거나, 시각이 초 단위까지 있을 때(초·메뉴·금액까지 같은 두 주문은 거의 없다).
  // 둘 다 없으면(분 단위) 같은 분에 같은 메뉴를 판 두 건과 구분할 수 없어 모두 세고, 똑같은 줄 수만 알려 준다.
  const timeCol = cols.datetime ?? cols.time
  const precise = timeCol !== undefined && rows.some((r) => hasSeconds(r[timeCol]))
  const dedupe = cols.id !== undefined || precise
  const seen = new Set<string>()
  for (const row of rows) {
    out.rowsRead++
    const key = row.map((c) => (c instanceof Date ? c.toISOString() : String(c ?? ''))).join('\u0001')
    if (seen.has(key)) {
      if (dedupe) {
        out.excluded.duplicate++
        continue
      }
      // 시각이 없으면 똑같은 줄이 당연히 많아서 안내하지 않는다
      if (timeCol !== undefined) out.sameRows++
    }
    seen.add(key)
    const get = (f: Field) => (cols[f] === undefined ? null : (row[cols[f] as number] ?? null))
    if (isCancelled(get('status'), get('cancel'), get('amount'))) {
      out.excluded.cancelled++
      continue
    }
    // 메뉴 열이 없으면 한 줄이 결제 한 건이다(수량 칸이 있어도 주문 1건으로 센다).
    const qty = cols.qty === undefined || !hasMenu ? 1 : Number(String(get('qty') ?? '').replace(/,/g, ''))
    if (!Number.isFinite(qty) || qty <= 0 || !Number.isInteger(qty)) {
      out.excluded.unreadable++
      continue
    }
    const menu = hasMenu ? String(get('menu') ?? '').trim() : ''
    if (hasMenu && !menu) {
      out.excluded.unreadable++
      continue
    }
    if (!hasTime) {
      out.undated[menu] = (own(out.undated, menu) ?? 0) + qty
      continue
    }
    const date = cols.datetime !== undefined ? readDate(get('datetime')) : readDate(get('date'))
    const minute = cols.datetime !== undefined ? readMinute(get('datetime')) : readMinute(get('time'))
    if (date === null || minute === null) {
      out.excluded.unreadable++
      continue
    }
    const day = (out.byDate[date] ??= { hours: Array(24).fill(0), menus: tally<number>(), hourMenus: Array.from({ length: 24 }, () => tally<number>()) })
    const hour = Math.floor(minute / 60)
    day.hours[hour] += qty
    if (menu) {
      day.menus[menu] = (own(day.menus, menu) ?? 0) + qty
      day.hourMenus[hour][menu] = (own(day.hourMenus[hour], menu) ?? 0) + qty
    }
  }
  if (hasTime && !Object.keys(out.byDate).length) throw new Error('읽을 수 있는 결제 줄이 없어요. 날짜·시각 형식을 확인해 주세요.')
  if (!hasTime && !Object.keys(out.undated).length) throw new Error('읽을 수 있는 판매 줄이 없어요.')
  return out
}

// ---------------------------------------------------------------- 집계 → 계산할 하루
export const weekdayOf = (date: string): Weekday => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay()
  return WEEKDAYS[(d + 6) % 7]
}

/** 소수 평균을 합계가 맞게 정수로(큰 나머지부터 1씩). */
export function roundKeepingTotal(values: number[]): number[] {
  const total = Math.round(values.reduce((a, b) => a + b, 0))
  const floors = values.map(Math.floor)
  let rest = total - floors.reduce((a, b) => a + b, 0)
  const order = values.map((v, i) => ({ i, f: v - floors[i] })).sort((a, b) => b.f - a.f || a.i - b.i)
  for (const { i } of order) {
    if (rest-- <= 0) break
    floors[i]++
  }
  return floors
}

/** 확인 메시지 대분류: 영업시간·손님 / 메뉴 */
export type NoteArea = 'HOURS' | 'MENU'

export type StorePlan = {
  basis: DayBasis
  /** 파일 결제가 전체 주문에서 차지하는 비율(1 = 보정 안 함). 카드 승인 내역이면 현금·쿠폰 손님이 빠져 있다. */
  cardShare: number
  /** 계산에 쓴 날 수와 기간 */
  days: number
  period: { from: string; to: string } | null
  /** 가장 주문이 많은 요일(평균 하루 주문 기준) */
  busiestWeekday: Weekday | null
  weekdayDays: Partial<Record<Weekday, number>>
  open: string | null
  close: string | null
  ordersBySlot: Record<string, number> | null
  peak: { start: string; end: string } | null
  dailyOrders: number
  /** 맞춘 메뉴의 하루 잔 수(카탈로그 menu_id) */
  menuCups: Record<string, number> | null
  /** 파일 메뉴 이름 → 하루 잔 수와 맞춘 메뉴(null: 빼고 계산) */
  menus: { name: string; cups: number; menuId: string | null; matched: boolean; how: MenuHow; chosen: boolean }[]
  outsideHours: number
  /** 파일에 없어서 기본값으로 채운 것 */
  defaults: string[]
  /** defaults와 같은 내용에 대분류를 붙인 것(확인 메시지용) */
  notes: { area: NoteArea; text: string }[]
  problems: string[]
}

const hh = (h: number) => `${pad(h)}:00`

/**
 * 계산할 하루를 만든다. basis: 평균 하루 또는 한 요일. peak: 사장님이 고친 바쁜 시간(없으면 주문이 가장 많은 연속 3시간).
 * mapping: 파일 메뉴 이름 → 카탈로그 메뉴(null이면 빼고 계산). 정해 주지 않은 이름은 자동으로 맞춘 결과를 쓴다.
 * cardShare: 파일에 담긴 결제의 비율(0.5~1). 1보다 작으면 시간대별 주문을 그만큼 늘린다(사장님이 넣은 가정).
 */
export const CARD_SHARE_MIN = 0.5
export function planFrom(
  imp: StoreImport,
  basis: DayBasis = 'AVERAGE',
  peak?: { start: string; end: string } | null,
  mapping: Record<string, string | null> = {},
  cardShare = 1,
  /** 낱말로 모른 메뉴를 AI가 고른 유형(menu_id, null = 음료 아님). 없으면 가장 많이 팔린 유형으로 채운다. */
  aiTypes: Record<string, string | null> = {},
): StorePlan {
  const share = Math.min(1, Math.max(CARD_SHARE_MIN, Number.isFinite(cardShare) ? cardShare : 1))
  const allDates = Object.keys(imp.byDate).sort()
  const weekdayDays: Partial<Record<Weekday, number>> = {}
  const weekdayTotals: Partial<Record<Weekday, number>> = {}
  for (const d of allDates) {
    const w = weekdayOf(d)
    weekdayDays[w] = (weekdayDays[w] ?? 0) + 1
    weekdayTotals[w] = (weekdayTotals[w] ?? 0) + imp.byDate[d].hours.reduce((a, b) => a + b, 0)
  }
  const busiestWeekday =
    (Object.keys(weekdayDays) as Weekday[]).sort(
      (a, b) => (weekdayTotals[b] ?? 0) / (weekdayDays[b] ?? 1) - (weekdayTotals[a] ?? 0) / (weekdayDays[a] ?? 1),
    )[0] ?? null
  const dates = basis === 'AVERAGE' ? allDates : allDates.filter((d) => weekdayOf(d) === basis)
  const defaults: string[] = []
  const notes: StorePlan['notes'] = []
  /** 우리가 채운 값: 기본값 목록(defaults)과 확인 메시지용 대분류(notes)에 같이 남긴다. */
  const fill = (area: NoteArea, text: string) => {
    defaults.push(text)
    notes.push({ area, text })
  }
  const problems: string[] = []
  const nDays = Math.max(1, dates.length)

  // 메뉴별 하루 잔 수(파일 이름 기준)
  const rawMenus = tally<number>()
  if (imp.hasTime) for (const d of dates) for (const [n, c] of Object.entries(imp.byDate[d].menus)) rawMenus[n] = (own(rawMenus, n) ?? 0) + c
  else Object.assign(rawMenus, imp.undated)
  const menuNames = Object.keys(rawMenus).sort((a, b) => rawMenus[b] - rawMenus[a])
  const divisor = imp.hasTime ? nDays : 1
  const found = menuNames.map((name) => {
    const known = classifyMenu(name) ?? (Object.hasOwn(aiTypes, name) ? { menuId: aiTypes[name], how: (aiTypes[name] ? 'AI' : 'FOOD') as MenuHow } : null)
    return { name, cups: rawMenus[name] / divisor, known }
  })
  // 이름으로 모르는 메뉴는 알아본 메뉴 중 가장 많이 팔린 유형으로 채운다(확인 필요로 표시).
  const typeCups: Record<string, number> = {}
  for (const f of found) if (f.known?.menuId) typeCups[f.known.menuId] = (typeCups[f.known.menuId] ?? 0) + f.cups
  const guessId = Object.keys(typeCups).sort((a, b) => typeCups[b] - typeCups[a])[0] ?? 'iced_americano'
  const menus = found.map(({ name, cups, known }) => {
    const auto = known ?? { menuId: guessId, how: 'GUESS' as MenuHow }
    const chosen = Object.hasOwn(mapping, name)
    return { name, cups, menuId: chosen ? mapping[name] : auto.menuId, matched: auto.how !== 'GUESS', how: auto.how, chosen }
  })
  // 빼고 계산하는 메뉴(음료가 아닌 것 등)는 시간대 주문에서도 뺀다.
  const dropped = new Set(menus.filter((m) => m.menuId === null).map((m) => m.name))

  let open: string | null = null
  let close: string | null = null
  let ordersBySlot: Record<string, number> | null = null
  let peakOut: StorePlan['peak'] = null
  let outsideHours = 0
  let dailyOrders = 0
  /** 영업시간 안에서 팔린 메뉴별 잔 수(시각이 있을 때). 메뉴 비중은 이 값으로 정해 영업시간 밖 주문이 섞이지 않게 한다. */
  let inHoursCups: Record<string, number> | null = null
  if (imp.hasTime) {
    if (!dates.length) problems.push('고른 요일의 데이터가 없어요.')
    const hourly = Array(24).fill(0)
    for (const d of dates) {
      const day = imp.byDate[d]
      // 빼는 메뉴는 그 시간에 실제로 팔린 잔 수만큼 덜어 낸다(점심에 몰린 음식이 다른 시간 주문을 깎지 않게).
      const droppedShare = (h: number) => [...dropped].reduce((a, n) => a + (own(day.hourMenus[h], n) ?? 0), 0)
      for (let h = 0; h < 24; h++) {
        const n = day.hours[h] - droppedShare(h)
        hourly[h] += n
      }
    }
    // 영업시간 판단은 파일 그대로, 주문 수는 보정한 값으로 센다.
    const avg = hourly.map((n) => n / nDays / share)
    const active = hourly.map((n) => n / nDays >= ACTIVE_HOURLY_MIN)
    let first = Math.max(STORE_OPEN_MIN, active.indexOf(true))
    let last = Math.min(STORE_CLOSE_MAX - 1, active.lastIndexOf(true))
    if (active.indexOf(true) < 0) {
      first = 7
      last = 18
    }
    if (last + 1 - first < STORE_MIN_HOURS) {
      problems.push(`주문이 있는 시간이 ${last + 1 - first}시간뿐이라 계산할 수 없어요(4시간 이상 필요).`)
    }
    open = hh(first)
    close = hh(last + 1)
    outsideHours = Math.round(avg.reduce((a, n, h) => (h < first || h > last ? a + n : a), 0) * 10) / 10
    inHoursCups = tally<number>()
    for (const d of dates)
      for (let h = first; h <= last; h++)
        for (const [n, c] of Object.entries(imp.byDate[d].hourMenus[h])) inHoursCups[n] = (own(inHoursCups, n) ?? 0) + c
    const inside = avg.slice(first, last + 1)
    const counts = roundKeepingTotal(inside)
    ordersBySlot = Object.fromEntries(counts.map((n, i) => [`${hh(first + i)}-${hh(first + i + 1)}`, n]))
    dailyOrders = counts.reduce((a, b) => a + b, 0)
    // 바쁜 시간: 고친 값, 없으면 주문이 가장 많은 연속 3시간(같으면 이른 시간)
    const hours = last + 1 - first
    if (peak && peak.start && peak.end) peakOut = peak
    else if (hours >= 1) {
      const len = Math.min(PEAK_HOURS, hours)
      let best = 0
      let bestSum = -1
      for (let s = 0; s + len <= hours; s++) {
        const sum = counts.slice(s, s + len).reduce((a, b) => a + b, 0)
        if (sum > bestSum) {
          bestSum = sum
          best = s
        }
      }
      peakOut = { start: hh(first + best), end: hh(first + best + len) }
    }
  } else {
    // 요일·시간대를 알 수 없어 요일별 근무표를 만들 수 없다(기본 영업시간을 지어내지 않고 이유를 보여 준다).
    problems.push('파일에 결제 날짜·시각이 없어 요일·시간대별 근무표를 만들 수 없어요. 결제 일시가 들어 있는 파일을 올려 주세요.')
  }

  // 메뉴 → 카탈로그 잔 수
  let menuCups: Record<string, number> | null = null
  if (imp.hasMenu) {
    const byId: Record<string, number> = {}
    for (const m of menus) {
      const cups = inHoursCups ? (own(inHoursCups, m.name) ?? 0) / nDays : m.cups
      if (m.menuId && cups > 0) byId[m.menuId] = (byId[m.menuId] ?? 0) + cups
    }
    const ids = Object.keys(byId).sort()
    if (ids.length) {
      const target = imp.hasTime ? dailyOrders : Math.round(ids.reduce((a, id) => a + byId[id], 0) / share)
      const raw = ids.map((id) => byId[id])
      const scale = raw.reduce((a, b) => a + b, 0)
      // 시각이 있으면 잔 수 합계를 시간대 합계에 맞춘다(둘 다 같은 줄에서 왔고 반올림만 다르다).
      const rounded = roundKeepingTotal(raw.map((v) => (scale > 0 ? (v / scale) * target : 0)))
      menuCups = Object.fromEntries(ids.map((id, i) => [id, rounded[i]]).filter(([, n]) => (n as number) > 0))
      if (!Object.keys(menuCups ?? {}).length) menuCups = null
    }
    if (!imp.hasTime) dailyOrders = menuCups ? Object.values(menuCups).reduce((a, b) => a + b, 0) : 0
    if (!menuCups) fill('MENU', '메뉴 구성: 맞춘 메뉴가 없어 기본 메뉴 5종과 기본 비중을 써요.')
    const guessed = menus.filter((m) => m.how === 'GUESS' && !m.chosen)
    if (guessed.length)
      fill('MENU', 
        `메뉴 ${guessed.length}개(${guessed.map((m) => m.name).join(', ')})는 이름으로 만드는 방식을 몰라 가장 많이 팔린 유형(${typeLabel(guessId)})으로 넣었어요. 아래 표에서 확인해 주세요.`,
      )
    const estimated = menus.filter((m) => (m.how === 'KEYWORD' || m.how === 'AI') && !m.chosen)
    if (estimated.length)
      fill('MENU', `메뉴 ${estimated.length}개는 이름 낱말로 만드는 방식을 추정했어요(온도가 없으면 아이스). 제조 시간은 그 유형의 기본값이에요.`)
  } else {
    fill('MENU', '메뉴 구성: 파일에 메뉴가 없어 기본 메뉴 5종과 기본 비중을 써요.')
  }
  if (share < 1)
    fill('HOURS', 
      `파일에 없는 결제(현금·쿠폰 등): 파일 결제를 전체의 ${Math.round(share * 100)}%로 보고 주문 수를 늘렸어요(사장님이 넣은 가정).`,
    )
  fill('MENU', '제조시간·주문/전달 처리시간: 기본 가정값이에요.')
  if (dailyOrders > MAX_DAILY_ORDERS) problems.push(`하루 ${dailyOrders}건은 계산 한도(${MAX_DAILY_ORDERS}건)를 넘어요.`)
  if (dailyOrders < 1 && !problems.length) problems.push('계산할 주문이 없어요.')

  return {
    basis,
    cardShare: share,
    days: imp.hasTime ? dates.length : 0,
    period: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    busiestWeekday,
    weekdayDays,
    open,
    close,
    ordersBySlot,
    peak: peakOut,
    dailyOrders,
    menuCups,
    menus: menus.map((m) => ({ ...m, cups: Math.round(m.cups * 10) / 10 })),
    outsideHours,
    defaults,
    notes,
    problems,
  }
}

/** 저장 입력(operation_form)에 남기는 근거. 원본 파일은 저장하지 않는다. */
export function sourceOf(imp: StoreImport, plan: StorePlan) {
  return {
    file_name: imp.fileName,
    basis: plan.basis,
    card_share: plan.cardShare,
    days: plan.days,
    period_from: plan.period?.from ?? null,
    period_to: plan.period?.to ?? null,
    rows_read: imp.rowsRead,
    rows_cancelled: imp.excluded.cancelled,
    rows_unreadable: imp.excluded.unreadable,
    rows_duplicate: imp.excluded.duplicate,
    has_time: imp.hasTime,
    has_menu: imp.hasMenu,
    defaults: plan.defaults,
  }
}
