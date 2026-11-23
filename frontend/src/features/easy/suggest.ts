// 장보기 계산이 안 될 때 서버(구매 계산)가 주는 "이 칸을 이 값으로 바꾸면 된다" 제안을 다루는 순수 함수들.
// 제안 값으로 다시 계산하면 서버가 원인 찾기에서 찾은 안이 조건을 지킨다(ai-server purchase _suggested_changes).
import type { JsonObject } from '../../types/workflow'
import { amountText } from './amounts.ts'

export type Suggested = { path: string; label: string; unit: string | null; current: number | null; suggested: number }

const ITEM_PATH = /^items\[(\d+)\]\.([a-z_]+)$/
const TOP_PATH = /^[a-z_]+$/

export function valueText(value: number | null, unit: string | null): string {
  if (value === null) return '정하지 않음'
  if (unit === '원') return `${value.toLocaleString('ko-KR')}원`
  if (unit === '회') return `${value}번`
  if (unit === 'g' || unit === 'ml' || unit === 'ea') return amountText(value, unit)
  return value.toLocaleString('ko-KR')
}

export function changeText(change: Suggested): string {
  return `${change.label} ${valueText(change.current, change.unit)} → ${valueText(change.suggested, change.unit)}`
}

/** 화면에서 바꿀 수 있는 제안만 남긴다(모르는 칸 이름은 고르지 않는다). */
export function usable(changes: unknown): Suggested[] {
  if (!Array.isArray(changes)) return []
  return changes.filter((c): c is Suggested =>
    !!c && typeof c === 'object'
    && typeof (c as Suggested).path === 'string'
    && (ITEM_PATH.test((c as Suggested).path) || TOP_PATH.test((c as Suggested).path))
    && typeof (c as Suggested).suggested === 'number' && Number.isFinite((c as Suggested).suggested))
}

/** 제안을 입력에 적용한 새 입력. 원래 입력은 건드리지 않는다. 없는 품목을 가리키면 null(임의로 만들지 않는다). */
export function applyChanges(input: JsonObject, changes: Suggested[]): JsonObject | null {
  const next = structuredClone(input) as JsonObject
  for (const change of changes) {
    const item = ITEM_PATH.exec(change.path)
    if (item) {
      const rows = next.items
      const row = Array.isArray(rows) ? rows[Number(item[1])] : null
      if (!row || typeof row !== 'object' || Array.isArray(row)) return null
      ;(row as JsonObject)[item[2]] = change.suggested
    } else {
      next[change.path] = change.suggested
    }
  }
  return next
}
