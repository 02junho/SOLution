import { rosterResultStatus } from '../../../api/operationApi'
import type { RosterJob, RosterProgress } from './rosterTypes'

/** 상태를 이만큼마다 확인한다. */
export const POLL_MS = 3000
/** 처음 몇 초는 더 자주 묻는다: 기억해 둔 요일로 금방 끝나는 계산(시급만 바꿈 등)을 3초씩 기다리지 않게. */
export const FAST_POLL_MS = 1000
export const FAST_FOR_MS = 5000
/** 이보다 오래 걸리면 기다리기를 멈추고 "나중에 다시 열기"를 안내한다(계산은 서버에서 계속된다). */
export const GIVE_UP_MS = 10 * 60 * 1000

export type PendingRoster = { sessionId: number; versionId: number; key: string }

/** 진행 상황(끝난 요일)을 받을 때는 이 간격으로 묻는다. 요일이 끝나는 대로 화면에 먼저 보이게. */
export const PROGRESS_POLL_MS = 2000

/** 끝날 때까지 기다린다. onTick(지난 초)으로 진행을, onProgress(선택)로 끝난 요일을 알린다. 멈추면(signal) null. */
export async function waitRoster(
  p: PendingRoster,
  onTick: (seconds: number) => void,
  signal?: { stopped: boolean },
  onProgress?: (progress: RosterProgress) => void,
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
    if (job.progress) onProgress?.(job.progress)
    const slow = onProgress ? PROGRESS_POLL_MS : POLL_MS
    await new Promise((resolve) => setTimeout(resolve, Date.now() - began < FAST_FOR_MS ? FAST_POLL_MS : slow))
  }
}
