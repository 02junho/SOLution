import type { FeatureType, ResponseStatus } from './api'

export type JsonObject = Record<string, unknown>
export type Page<T> = { items: T[]; next_cursor: string | null }
export type SessionSummary = {
  session_id: number
  feature_type: FeatureType
  title: string
  step: string
  current_version: number
  updated_at: string
}
export type SessionContext = SessionSummary & {
  store_id: number
  input_method: 'agent' | 'form'
  current_input?: JsonObject | null
  current_version_id: number | null
  input_confirmed: boolean
  latest_result_id: number | null
  has_confirmation: boolean
  created_at: string
}
export type Message = {
  message_id: number
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  version_no: number | null
  metadata_json: JsonObject | null
  created_at: string
}
export type EventData = JsonObject & {
  input_version_id?: number | null
  question_id?: string
  base_version_id?: number | null
  parsed_input?: { input?: JsonObject }
  draft_input?: JsonObject
  question?: { text?: string; choices?: string[] }
  missing_fields?: { path: string; label: string }[]
}
export type Warning = {
  warning_id: string
  message: string
  requires_ack: boolean
  choice_keys?: string[]
}
export type Choice = JsonObject & {
  choice_key: string
  label?: string
  available?: boolean
  confirmable?: boolean
  same_as?: string | null
  total_krw?: number
  delivery_count?: number
  diff_from_baseline_krw?: number
  unavailable_reason?: string
}
export type PurchaseResult = {
  result_id: number
  session_id: number
  input_version_id: number
  version_no: number
  response_status: ResponseStatus
  detail_status?: string
  is_latest_version: boolean
  confirmed_choice_key: string | null
  summary: {
    choices?: Choice[]
    warnings?: Warning[]
    assumptions?: string[]
    baseline?: JsonObject
    missing_fields?: { path: string; label: string }[]
    suggested_changes?: {
      path: string
      label: string
      unit: string | null
      current: number | null
      suggested: number
    }[]
    message?: string
  }
  detail: {
    choices?: {
      choice_key: string
      lines?: JsonObject[]
      order_messages?: { supplier_id: string; text: string }[]
    }[]
  } | null
}
export type Confirmation = {
  confirmation_id: number
  session_id: number
  feature_type: FeatureType
  selected_choice_key: string
  version_no: number
  is_current_version: boolean
  confirmed_at: string
}
export type ConfirmationDetail = Omit<Confirmation, 'version_no'> & {
  result_id: number
  input_version_id: number
  confirmed_by: string
  acknowledged_warnings_json: (
    string | { warning_id: string; label?: string }
  )[]
  selected_snapshot_json: JsonObject
}
export type Confirmed = {
  confirmation_id: number
  is_new: boolean
  is_current_version: boolean
}
