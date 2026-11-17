import { useCallback, useRef, useState } from 'react'
import { workflowApi, WorkflowError } from '../../api/workflowApi.ts'
import type { FeatureType } from '../../types/api'
import type {
  Confirmation,
  JsonObject,
  Message,
  PurchaseResult,
  SessionContext,
} from '../../types/workflow'
import { confirmationKey, currentInput, RequestKeys } from './model.ts'

type Workspace = {
  context: SessionContext | null
  messages: Message[]
  input: JsonObject | null
  result: PurchaseResult | null
  saved: Confirmation | null
}
const empty: Workspace = {
  context: null,
  messages: [],
  input: null,
  result: null,
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
  return {
    context,
    messages,
    input: currentInput(messages, context.current_version_id),
    result:
      result?.input_version_id === context.current_version_id ? result : null,
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
  const pendingEvents = useRef(
    new Map<number, { signature: string; payload: JsonObject; key: string }>(),
  )
  const [pendingSessions, setPendingSessions] = useState<number[]>([])
  const keys = useRef(new RequestKeys())
  const open = useCallback(async (id: number) => {
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
      scope.current++
      setWorkspace(empty)
      setError('')
      setNotice('')
      setBusy('')
    }
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
  function calculate() {
    return act('조건에 맞는 구매안을 계산하고 있어요', async (context) => {
      if (!context.input_confirmed || !context.current_version_id)
        throw new Error('입력을 먼저 확인해 주세요.')
      if (context.feature_type !== 'purchase')
        throw new Error('운영 계산 화면은 준비 중이에요.')
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
      const result = workspace.result
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
        ? '구매 계획을 저장했어요. 저장한 계획에서 다시 볼 수 있어요.'
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
