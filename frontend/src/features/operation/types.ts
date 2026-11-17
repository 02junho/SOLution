import type { OperationPlan, ResponseStatus } from '../../types/api'

export type Warning = { warning_id: string; message: string; requires_ack: boolean }
export type MissingField = { path: string; label: string; unit: string | null }
export type Metrics = {
  order_queue_wait_mean_seconds: number | null
  post_order_wait_mean_seconds: number | null
  total_time_mean_seconds: number | null
  total_time_p90_seconds: number | null
  post_order_wait_over_300_ratio: number | null
  completed_customer_count_mean: number | null
  throughput_per_hour_mean: number | null
}
export type Comparison = {
  metric: keyof Metrics
  delta_vs_current_seconds: number
  ci95_lower_seconds: number
  ci95_upper_seconds: number
  better_count: number
  paired_repetitions: number
  label?: string
}
export type StaffingEmployee = {
  staff_id: string
  primary_role: 'ORDER' | 'MAKE' | 'FLEX'
  can_support: ('ORDER' | 'MAKE')[]
  start_time: string
  end_time: string
}
export type Closing = { failed_repetitions: number; success_ratio: number; [key: string]: unknown }
export type PlanSummary = {
  staffing?: { employees: StaffingEmployee[]; peak_staff_count?: number; total_staff_hours?: number }
  closing?: Closing | null
  choice_key: OperationPlan
  metrics: Metrics
  comparison: Comparison | null
  cash_cost_krw: number | null
  additional_cash_cost_krw: number | null
  owner_work_seconds: number | null
  monthly_cash_cost_estimate_krw?: number | null
  additional_monthly_cash_cost_estimate_krw?: number | null
  cost_scope?: string
  staffing_summary?: {
    start_time: string
    end_time: string
    max_concurrent_workers: number
    assignments: { worker_key: string; task_code: string; start_time: string; end_time: string; primary_role?: string | null; can_support?: string[]; is_owner?: boolean }[]
    total_staff_hours?: number
    simulation_excludes_breaks: boolean
  }
}
export type Shift = {
  worker_key: string
  start_time: string
  end_time: string
  task_code: string
  primary_role?: string | null
  can_support?: string[]
  breaks: { start_time: string; end_time: string; is_paid: boolean }[]
}
export type TraceRef = {
  result_id: number
  log_id: number
  choice_key: OperationPlan
  replication_no: number
  is_complete: boolean
}
export type OperationSummary = {
  choice_keys?: OperationPlan[]
  plans?: PlanSummary[]
  comparison_window?: { start_time: string; end_time: string }
  requested_repetitions?: number
  completed_repetitions?: number
  statistics_policy_version?: string
  recommendation?: { choice_key: OperationPlan; reason: string; basis_metric: keyof Metrics } | null
  warnings?: Warning[]
  assumptions?: string[]
  missing_fields?: MissingField[]
  violations?: { message?: string; code?: string }[]
  suggestions?: string[]
  message?: string | null
}
export type OperationDetail = {
  schedule: { plans: { choice_key: OperationPlan; schedule: Shift[] }[]; worker_context?: Record<string, { is_owner: boolean }> }
  trace_refs: TraceRef[]
  metric_definitions?: Record<string, unknown>
  statistics_policy_version?: string
}
export type OperationResult = {
  result_id: number
  session_id: number
  input_version_id: number
  version_no: number
  feature_type: 'operation'
  response_status: ResponseStatus
  detail_status: string | null
  created_at: string
  is_latest_version: boolean
  confirmed_choice_key: OperationPlan | null
  summary: OperationSummary
  detail: OperationDetail | null
}
export type EventType = 'ARRIVED' | 'ORDER_STARTED' | 'ORDER_COMPLETED' | 'PREPARATION_STARTED'
  | 'PREPARATION_COMPLETED' | 'HANDOFF_STARTED' | 'HANDED_OVER' | 'STAFF_ON' | 'STAFF_OFF'
export type TraceEvent = {
  sequence_no: number
  at_seconds: number
  event_type: EventType
  customer_key: string | null
  worker_key: string | null
}
export type CustomerStage = 'ORDER_QUEUE' | 'ORDERING' | 'WAITING_PREPARATION' | 'PREPARING' | 'WAITING_HANDOFF' | 'DONE'
export type InitialState = {
  active_staff_keys: string[]
  customers: { customer_key: string; state: CustomerStage; worker_key?: string | null }[]
  order_queue: string[]
  preparation_queue: string[]
  in_service: { customer_key: string; worker_key: string; stage: CustomerStage }[]
  completed_customer_count: number
}
export type OperationTrace = TraceRef & {
  session_id: number
  input_version_id: number
  trace_schema_version: 'operation.trace.v1' | 'operation.trace.v2'
  time_origin: string
  time_unit: 'seconds'
  observation_window?: { start_seconds: number; end_seconds: number }
  event_count: number
  initial_state: InitialState | null
  events: TraceEvent[]
}

export const CHOICE_LABELS: Record<OperationPlan, string> = {
  CURRENT: '현재 방식', ALT_A: 'A · 서로 돕기', ALT_C: 'C · 한 명 추가',
}
