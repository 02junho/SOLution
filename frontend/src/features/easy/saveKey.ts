// 계획 저장 요청 키. 저장 중 연결이 끊겨 다시 눌러도 같은 키를 보내서 서버가 한 번만 저장하게 한다.
// 키 모양·보관(sessionStorage)은 예전 업무 화면(useWorkspace.confirm)과 같아서, 두 화면에서 같은 안을 저장해도 하나로 묶인다.
import { confirmationKey, invalidateConfirmationKeys } from '../workflow/model.ts'

function storage(): Storage | undefined {
  try { return window.sessionStorage } catch { return undefined }
}

/** 같은 결과·같은 조건 버전·같은 안·같은 확인 항목이면 같은 키 */
export function saveKey(resultId: number, versionId: number, choice: string, acks: string[]): string {
  return confirmationKey(JSON.stringify([resultId, versionId, choice, [...acks].sort()]), storage())
}

/** 저장한 계획을 지웠으면 그 결과의 예전 키를 버린다. 다시 저장할 때 지운 계획이 되살아나지 않고 새로 저장된다. */
export function forgetSaves(resultId: number) {
  invalidateConfirmationKeys(resultId, storage())
}
