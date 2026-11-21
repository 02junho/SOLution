import { rosterResultStatus } from '../../../api/operationApi'
import type { RosterJob } from './rosterTypes'

/** 상태를 이만큼마다 확인한다. */
export const POLL_MS = 3000
/** 이보다 오래 걸리면 기다리기를 멈추고 "나중에 다시 열기"를 안내한다(계산은 서버에서 계속된다). */
export const GIVE_UP_MS = 10 * 60 * 1000

export type PendingRoster = { sessionId: number; versionId: number; key: string }

/** 이어 보기 주소. 화면을 나갔다가 이 주소로 다시 열면 계산이 끝났는지 다시 확인한다. */
export const pendingHash = (p: PendingRoster) =>
  `#/lab?${new URLSearchParams({ session: String(p.sessionId), version: String(p.versionId), key: p.key })}`
export const resultHash = (resultId: number) => `#/lab?result=${resultId}`

export function readPending(hash: string): PendingRoster | null {
  const q = new URLSearchParams(hash.split('?')[1] ?? '')
  const sessionId = Number(q.get('session'))
  const versionId = Number(q.get('version'))
  const key = q.get('key')
  return Number.isInteger(sessionId) && sessionId > 0 && Number.isInteger(versionId) && versionId > 0 && key
    ? { sessionId, versionId, key }
    : null
}

/** 주소창만 바꾼다(화면은 다시 그리지 않음). 새로고침·다시 열기 때 이어서 보기 위해. */
export const rememberHash = (hash: string) => window.history.replaceState(null, '', hash)

/** 끝날 때까지 기다린다. onTick(지난 초)으로 진행을 알린다. 멈추면(signal) null. */
export async function waitRoster(
  p: PendingRoster,
  onTick: (seconds: number) => void,
  signal?: { stopped: boolean },
): Promise<RosterJob | null> {
  const began = Date.now()
  for (;;) {
    if (signal?.stopped) return null
    const response = await rosterResultStatus(p.sessionId, p.versionId, p.key)
    if (response.status !== 'ok' || !response.data) throw new Error(response.message ?? '계산 상태를 확인하지 못했어요.')
    const job = response.data
    if (job.state === 'DONE') return job
    if (job.state === 'FAILED' || job.state === 'LOST') throw new Error(response.message ?? '추천 근무표를 만들지 못했어요. 다시 계산해 주세요.')
    if (Date.now() - began > GIVE_UP_MS) {
      throw new Error('계산이 오래 걸리고 있어요. 계산은 서버에서 계속되니 잠시 뒤 이 주소를 다시 열어 주세요.')
    }
    onTick(Math.round((Date.now() - began) / 1000))
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
