// 쉬운 화면(기본 화면) 안의 주소(#). 원래 업무 화면으로 넘어가지 않고 쉬운 화면 안에서 오간다.
//   #/            홈(새로 시작)
//   #/work        하던 일 목록
//   #/work/123    그 업무 열기(결과가 있으면 결과, 없으면 조건 확인부터)
//   #/plans       저장한 계획 목록
//   #/plans/456   저장한 계획 보기
export type EasyRoute =
  | { kind: 'home' }
  | { kind: 'sessions' }
  | { kind: 'session'; id: number }
  | { kind: 'plans' }
  | { kind: 'plan'; id: number }

export function parseHash(hash: string): EasyRoute {
  const path = hash.replace(/^#/, '')
  let match = /^\/work\/(\d+)$/.exec(path)
  if (match) return { kind: 'session', id: Number(match[1]) }
  match = /^\/plans\/(\d+)$/.exec(path)
  if (match) return { kind: 'plan', id: Number(match[1]) }
  if (/^\/work\/?$/.test(path)) return { kind: 'sessions' }
  if (/^\/plans\/?$/.test(path)) return { kind: 'plans' }
  return { kind: 'home' }
}

export function routeHash(route: EasyRoute): string {
  switch (route.kind) {
    case 'session': return `#/work/${route.id}`
    case 'plan': return `#/plans/${route.id}`
    case 'sessions': return '#/work'
    case 'plans': return '#/plans'
    default: return '#/'
  }
}
