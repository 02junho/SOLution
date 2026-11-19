import { useCallback, useRef, useState } from 'react'
import { workflowApi, WorkflowError } from '../../api/workflowApi.ts'
import { request } from '../../api/client.ts'
import type { OperationResult } from '../operation/types'
import type { FeatureType } from '../../types/api'
import type {
  Confirmation,
  JsonObject,
  Message,
  PurchaseResult,
  SessionContext,
} from '../../types/workflow'
import { confirmationKey, currentInput, RequestKeys } from './model.ts'

// 운영 결과 API (api/operationApi.ts와 같은 주소). node 테스트가 확장자 있는 경로만 읽어서 여기서 직접 부른다.
const loadOperationResult = (resultId: number, view: 'summary' | 'detail') =>
  request<OperationResult>(`/v1/operation/results/${resultId}?view=${view}`)
// 같은 실행을 다시 보낼 때는 같은 Idempotency-Key를 쓴다(필수, API v0.4).
const runOperation = (sessionId: number, inputVersionId: number, key: string) =>
  request<OperationResult>(`/v1/operation/sessions/${sessionId}/results`, {
    method: 'POST',
    headers: { 'Idempotency-Key': key },
    body: JSON.stringify({ input_version_id: inputVersionId }),
  })
type Workspace = {
  context: SessionContext | null
  messages: Message[]
  input: JsonObject | null
  result: PurchaseResult | null
  // 운영 실험 결과(Spring 운영 API). 구매 결과와 모양이 달라 따로 둔다.
  operation: OperationResult | null
  saved: Confirmation | null
}
const empty: Workspace = {
  context: null,
  messages: [],
  input: null,
  result: null,
  operation: null,
  saved: null,
}
async function load(id: number): Promise<Workspace> {
  const [context, messages, confirmations] = await Promise.all([
    workflowApi.context(id),
    workflowApi.allMessages(id),
    workflowApi.confirmations(undefined, null, id),
  ])
  const result =
    context.latest_result_id && context.feature_type === 'purchase'
      ? await workflowApi.result(context.latest_result_id)
      : null
  const operation =
    context.latest_result_id && context.feature_type === 'operation'
      ? await loadOperationResult(context.latest_result_id, 'summary')
      : null
  // 결과를 못 읽었으면 "비교했어요"로 넘기지 않고 다시 불러오기 안내로 보낸다.
  if (operation && operation.status !== 'ok')
    throw new WorkflowError(
      operation.message ?? '운영 결과를 불러오지 못했어요.',
      undefined,
      operation.httpStatus,
    )
  return {
    context,
    messages,
    input:
      context.current_input ??
      currentInput(messages, context.current_version_id),
    result:
      result?.input_version_id === context.current_version_id ? result : null,
    operation:
      operation?.status === 'ok' &&
      operation.data?.input_version_id === context.current_version_id
        ? operation.data
        : null,
    saved:
      confirmations.items.find(
        (item) =>
          item.is_current_version &&
          item.version_no === context.current_version,
      ) ?? null,
  }
}
export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace>(empty)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const scope = useRef(0)
  const locked = useRef(false)
  const queuedOpen = useRef<number | null>(null)
  const activeSession = useRef<number | null>(null)
  const pendingEvents = useRef(
    new Map<number, { signature: string; payload: JsonObject; key: string }>(),
  )
  const [pendingSessions, setPendingSessions] = useState<number[]>([])
  const keys = useRef(new RequestKeys())
  // 운영 대화에서 "비교 시작해줘"라고 하면 대화 응답에 계산 시작 표시(action: run_operation)가 온다.
  const runAfterEvent = useRef(false)
  const open = useCallback(async (id: number) => {
    activeSession.current = id
    if (locked.current) {
      queuedOpen.current = id
      scope.current++
      setWorkspace(empty)
      setError('')
      setNotice('')
      setBusy('진행 중인 요청이 끝나면 선택한 업무를 열어요')
      return
    }
    const generation = ++scope.current
    setWorkspace(empty)
    setError('')
    setNotice('')
    setBusy('업무를 불러오고 있어요')
    try {
      const next = await load(id)
      if (scope.current === generation) setWorkspace(next)
    } catch (cause) {
      if (scope.current === generation)
        setError(
          cause instanceof Error ? cause.message : '업무를 불러오지 못했어요.',
        )
    } finally {
      if (scope.current === generation) setBusy('')
    }
  }, [])
  function release(generation: number) {
    locked.current = false
    const next = queuedOpen.current
    queuedOpen.current = null
    if (next !== null) void open(next)
    else if (scope.current === generation) setBusy('')
  }
  function clearPending(id: number) {
    pendingEvents.current.delete(id)
    setPendingSessions([...pendingEvents.current.keys()])
  }
  function reset() {
    if (!locked.current) {
      activeSession.current = null
      scope.current++
      setWorkspace(empty)
      setError('')
      setNotice('')
      setBusy('')
    }
  }
  // 삭제 완료 시점의 표시/조회 대상을 확인한다. 다른 업무의 진행 중인 open은 건드리지 않는다.
  function invalidate(id: number) {
    clearPending(id)
    if (queuedOpen.current === id) queuedOpen.current = null
    if (activeSession.current !== id) return false
    activeSession.current = null
    scope.current++
    setWorkspace(empty)
    setError('')
    setNotice('')
    setBusy('')
    return true
  }
  async function create(
    feature: FeatureType,
    method: 'agent' | 'form',
    title: string,
  ): Promise<number | null> {
    if (locked.current || busy) return null
    locked.current = true
    const generation = ++scope.current
    setBusy('새 업무를 준비하고 있어요')
    setError('')
    try {
      const store = Number(import.meta.env.VITE_STORE_ID ?? 1)
      const session = await workflowApi.create(store, feature, method, title)
      return queuedOpen.current === null ? session.session_id : null
    } catch (cause) {
      if (scope.current === generation)
        setError(
          cause instanceof Error ? cause.message : '업무를 시작하지 못했어요.',
        )
      return null
    } finally {
      release(generation)
    }
  }
  async function act(
    label: string,
    action: (context: SessionContext) => Promise<string>,
    replay = false,
  ): Promise<boolean> {
    const context = workspace.context
    if (!context || locked.current || busy) return false
    if (!replay && pendingEvents.current.has(context.session_id)) {
      setError(
        '이전 입력 요청의 처리 여부부터 확인해 주세요. 재전송 버튼을 눌러 주세요.',
      )
      return false
    }
    locked.current = true
    const generation = scope.current
    setBusy(label)
    setError('')
    setNotice('')
    try {
      const message = await action(context)
      try {
        const next = await load(context.session_id)
        if (scope.current === generation) setWorkspace(next)
      } catch {
        if (scope.current === generation)
          setError(
            '요청은 처리됐지만 화면을 새로 불러오지 못했어요. 새로고침 버튼을 눌러 주세요.',
          )
      }
      if (scope.current === generation) setNotice(message)
      return true
    } catch (cause) {
      // 응답을 잃어도 서버가 저장했을 수 있다. 재조회하고 원래 요청키는 재시도에 유지한다.
      try {
        const next = await load(context.session_id)
        if (scope.current === generation) setWorkspace(next)
      } catch {
        /* 원래 오류 문구를 유지한다. */
      }
      if (scope.current === generation)
        setError(
          cause instanceof Error ? cause.message : '요청을 완료하지 못했어요.',
        )
      return false
    } finally {
      release(generation)
    }
  }
  async function event(body: JsonObject) {
    const generation = scope.current
    const ok = await sendEvent(body)
    if (ok && runAfterEvent.current) {
      runAfterEvent.current = false
      // 기다리는 동안 다른 업무를 열었으면 계산하지 않는다. 계산 실패는 따로 보이고, 보낸 말은 저장된 것으로 둔다.
      if (scope.current === generation) await calculateOperation()
    }
    return ok
  }
  async function sendEvent(body: JsonObject) {
    return act(
      '입력을 확인하고 있어요',
      async (context) => {
        const id = context.session_id
        const signature = JSON.stringify(body)
        let pending = pendingEvents.current.get(id)
        if (pending && pending.signature !== signature) {
          throw new Error(
            '이전 입력 요청의 처리 여부부터 확인해 주세요. 재전송 버튼을 눌러 주세요.',
          )
        }
        if (!pending) {
          pending = {
            signature,
            payload: structuredClone({
              ...body,
              base_version_id: context.current_version_id,
            }),
            key: crypto.randomUUID(),
          }
          pendingEvents.current.set(id, pending)
          setPendingSessions([...pendingEvents.current.keys()])
        }
        try {
          const response = await workflowApi.event(
            id,
            pending.payload,
            pending.key,
          )
          clearPending(id)
          runAfterEvent.current =
            context.feature_type === 'operation' &&
            (response.data as JsonObject | null)?.action === 'run_operation'
          return response.message ?? '입력을 반영했어요.'
        } catch (cause) {
          if (
            cause instanceof WorkflowError &&
            cause.httpStatus &&
            cause.httpStatus >= 400 &&
            cause.httpStatus < 500
          ) {
            clearPending(id)
            if (
              cause.code === 'STALE_INPUT' ||
              cause.message ===
                '조건이 바뀌었어요. 최신 입력을 불러온 뒤 다시 보내 주세요.'
            ) {
              throw new WorkflowError(
                '이전 입력 요청은 저장되지 않았고 조건이 바뀌었어요. 최신 조건을 검토한 뒤 새 요청으로 보내 주세요.',
                'STALE_INPUT',
                cause.httpStatus,
              )
            }
          }
          throw cause
        }
      },
      true,
    )
  }
  function retryEvent() {
    const id = workspace.context?.session_id
    const pending = id === undefined ? undefined : pendingEvents.current.get(id)
    return pending
      ? event(JSON.parse(pending.signature) as JsonObject)
      : Promise.resolve(false)
  }
  function confirmInput() {
    return act('입력 조건을 확인하고 있어요', async (context) => {
      if (!context.current_version_id)
        throw new Error('먼저 입력을 저장해 주세요.')
      await workflowApi.confirmInput(
        context.current_version_id,
        context.current_version,
      )
      return '입력을 확인했어요. 이제 이 조건으로 계산할 수 있어요.'
    })
  }
  function calculateOperation() {
    return act(
      '세 운영안을 30번씩 돌려 비교하고 있어요. 보통 10~30초, 주문이 많으면 1분 넘게 걸려요',
      async (context) => {
        if (!context.current_version_id) throw new Error('먼저 입력을 저장해 주세요.')
        // 운영은 "세 운영안 비교하기" 한 번으로 입력 확인과 계산을 이어서 한다(확인 단계 안내를 따로 띄우지 않음).
        if (!context.input_confirmed)
          await workflowApi.confirmInput(context.current_version_id, context.current_version)
        const signature = `operation:${context.session_id}:${context.current_version_id}`
        const started = Date.now()
        const response = await runOperation(
          context.session_id,
          context.current_version_id,
          keys.current.for(signature),
        )
        if (response.status === 'error' || !response.data) {
          const code = (response.data as unknown as JsonObject | null)?.detail_code
          // 응답 대기 한도(Spring → FastAPI 120초)를 넘겼으면 주문 수를 줄이도록 안내한다.
          throw new WorkflowError(
            Date.now() - started >= 115_000
              ? '계산이 제한 시간(120초) 안에 끝나지 않았어요. 하루 주문 건수를 줄이거나 잠시 뒤 다시 실행해 주세요.'
              : (response.message ?? '운영 계산을 완료하지 못했어요.'),
            typeof code === 'string' ? code : undefined,
            response.httpStatus,
          )
        }
        keys.current.done(signature)
        return response.data.response_status === 'ok'
          ? '세 운영안을 비교했어요. 차이를 보고 직접 선택해 주세요.'
          : (response.message ?? '조건을 다시 확인해 주세요.')
      },
    )
  }
  function calculate() {
    if (workspace.context?.feature_type === 'operation') return calculateOperation()
    return act('조건에 맞는 구매안을 계산하고 있어요', async (context) => {
      if (!context.input_confirmed || !context.current_version_id)
        throw new Error('입력을 먼저 확인해 주세요.')
      if (context.feature_type !== 'purchase')
        throw new Error('운영 계산은 운영 업무에서 실행해 주세요.')
      const signature = `calculate:${context.session_id}:${context.current_version_id}`
      const response = await workflowApi.calculate(
        context.session_id,
        context.current_version_id,
        keys.current.for(signature),
      )
      keys.current.done(signature)
      return (
        response.message ??
        (response.status === 'ok'
          ? '구매안을 계산했어요. 비교한 뒤 직접 선택해 주세요.'
          : '조건을 다시 확인해 주세요.')
      )
    })
  }
  function confirm(choice: string, warnings: string[]) {
    return act('선택한 계획을 저장하고 있어요', async (context) => {
      const operation = context.feature_type === 'operation'
      const result = operation ? workspace.operation : workspace.result
      if (
        !result ||
        !context.current_version_id ||
        result.input_version_id !== context.current_version_id
      )
        throw new Error('최신 결과를 다시 확인해 주세요.')
      const signature = JSON.stringify([
        result.result_id,
        context.current_version_id,
        choice,
        [...warnings].sort(),
      ])
      let storage: Storage | undefined
      try {
        storage = window.sessionStorage
      } catch {
        /* 메모리 키로 재시도한다. */
      }
      const key = confirmationKey(signature, storage)
      const response = await workflowApi.confirm(
        result.result_id,
        context.current_version_id,
        choice,
        warnings,
        key,
      )
      return response.is_new
        ? `${operation ? '운영' : '구매'} 계획을 저장했어요. 저장한 계획에서 다시 볼 수 있어요.`
        : '이미 저장된 계획을 불러왔어요.'
    })
  }
  return {
    ...workspace,
    busy,
    error,
    notice,
    open,
    reset,
    invalidate,
    refresh: () => { if (activeSession.current !== null) void open(activeSession.current) },
    create,
    event,
    pendingEvent:
      workspace.context !== null &&
      pendingSessions.includes(workspace.context.session_id),
    retryEvent,
    confirmInput,
    calculate,
    confirm,
    dismissError: () => setError(''),
  }
}
export type WorkspaceController = ReturnType<typeof useWorkspace>
