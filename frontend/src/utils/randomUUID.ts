// 요청 키(request_key)·임시 ID를 만드는 crypto.randomUUID는 https·localhost(보안 연결)에서만 브라우저가 준다.
// 배포 주소는 지금 http라 이 함수가 없어 계산·저장이 TypeError로 멈춘다. 없을 때만 같은 형식(UUID v4)의 대체 함수를 넣는다.
// crypto.getRandomValues는 http에서도 쓸 수 있다. main.tsx에서 App보다 먼저 불러온다.

/** crypto.getRandomValues로 만든 UUID v4 문자열 */
export function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 0x0f) | 0x40 // 버전 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80 // RFC 4122 변형
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** crypto.randomUUID가 없으면 uuidV4를 대신 넣는다. 이미 있으면 그대로 둔다. */
export function ensureRandomUUID(target: Crypto | undefined = globalThis.crypto): void {
  if (!target || typeof target.randomUUID === 'function') return
  Object.defineProperty(target, 'randomUUID', { value: uuidV4 as Crypto['randomUUID'], configurable: true, writable: true })
}

ensureRandomUUID()
