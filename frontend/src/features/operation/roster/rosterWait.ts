/** 서버의 대기시간은 초 단위. 집계가 끝난 뒤 한 번만 반올림한다. */
export function waitText(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return '—'
  const total = Math.round(sec)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes ? `${minutes}분${seconds ? ` ${seconds}초` : ''}` : `${seconds}초`
}

export function validWait(sec: number | null | undefined): sec is number {
  return sec != null && Number.isFinite(sec) && sec >= 0
}

/** 계산된 요일만 평균에 넣는다. 초 단위를 그대로 유지한다. */
export function averageWait(values: (number | null | undefined)[]): number | null {
  const valid = values.filter(validWait)
  return valid.length ? valid.reduce((a, b) => a + b, 0) / valid.length : null
}
