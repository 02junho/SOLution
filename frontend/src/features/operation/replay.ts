import type { CustomerStage, OperationTrace } from './types'

export type ReplayState = { customers: Map<string, CustomerStage>; activeStaff: Set<string>; completed: number; initialKnown: boolean }

// 재생 프레임마다 같은 이벤트를 다시 정렬하지 않도록 이벤트 배열별로 정렬 결과를 한 번만 만든다.
// 원본 배열은 바꾸지 않고, 배열이 바뀌면(새 trace) 새로 정렬한다.
const sortedEvents = new WeakMap<OperationTrace['events'], OperationTrace['events']>()
function sorted(events: OperationTrace['events']) {
  let result = sortedEvents.get(events)
  if (!result) {
    result = [...events].sort((a, b) => a.at_seconds - b.at_seconds || a.sequence_no - b.sequence_no)
    sortedEvents.set(events, result)
  }
  return result
}

/** 매번 초기 상태부터 재구성하므로 뒤로 이동해도 이전 재생 상태가 섞이지 않는다. 통계 계산은 하지 않는다. */
export function stateAt(trace: OperationTrace, atSeconds: number): ReplayState {
  const initial = trace.initial_state ?? {
    customers: [], order_queue: [], preparation_queue: [], in_service: [],
    active_staff_keys: [], completed_customer_count: 0,
  }
  const customers = new Map<string, CustomerStage>(initial.customers.map(row => [row.customer_key, row.state]))
  for (const key of initial.order_queue) customers.set(key, 'ORDER_QUEUE')
  for (const key of initial.preparation_queue) customers.set(key, 'WAITING_PREPARATION')
  for (const row of initial.in_service) customers.set(row.customer_key, row.stage)
  const activeStaff = new Set(initial.active_staff_keys)
  let completed = initial.completed_customer_count
  for (const event of sorted(trace.events)) {
    if (event.at_seconds > atSeconds) break
    if (event.event_type === 'STAFF_ON' && event.worker_key) activeStaff.add(event.worker_key)
    if (event.event_type === 'STAFF_OFF' && event.worker_key) activeStaff.delete(event.worker_key)
    const key = event.customer_key
    if (!key) continue
    switch (event.event_type) {
      case 'ARRIVED': customers.set(key, 'ORDER_QUEUE'); break
      case 'ORDER_STARTED': customers.set(key, 'ORDERING'); break
      case 'ORDER_COMPLETED': customers.set(key, 'WAITING_PREPARATION'); break
      case 'PREPARATION_STARTED': customers.set(key, 'PREPARING'); break
      case 'PREPARATION_COMPLETED':
      case 'HANDOFF_STARTED': customers.set(key, 'WAITING_HANDOFF'); break
      case 'HANDED_OVER':
        if (customers.get(key) !== 'DONE') completed += 1
        customers.set(key, 'DONE')
        break
    }
  }
  return { customers, activeStaff, completed, initialKnown: trace.initial_state != null }
}

export function simulationClock(origin: string, elapsed: number): string {
  const [hour, minute, second = 0] = origin.split(':').map(Number)
  const total = hour * 3600 + minute * 60 + second + Math.floor(elapsed)
  return [Math.floor(total / 3600) % 24, Math.floor(total / 60) % 60, total % 60].map(v => String(v).padStart(2, '0')).join(':')
}
