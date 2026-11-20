// 처음 쓰는 사장님용 사용법 카드 내용과 "이미 봤어요" 기록.

export type GuideSlide = {
  key: string
  eyebrow: string
  title: string
}

export const GUIDE_SLIDES: GuideSlide[] = [
  { key: 'what', eyebrow: '무엇을 도와주나요', title: '카페 사장님의 두 가지 고민을\n대신 계산해요' },
  { key: 'steps', eyebrow: '이렇게 써요', title: '다섯 단계면 끝나요' },
  { key: 'talk', eyebrow: '이렇게 말해 보세요', title: '평소 말투로 적으면 돼요' },
  { key: 'notes', eyebrow: '알아 두세요', title: '결정과 실행은 사장님이 해요' },
]

const SEEN_KEY = 'solution.guide.seen'

// 브라우저 저장소는 막혀 있을 수 있어서(사생활 보호 모드 등) 실패해도 화면은 그대로 둔다.
export function guideSeen(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1'
  } catch {
    return true
  }
}

// 처음 방문이면 업무 첫 화면(주소 없음·#/work)에서만 자동으로 연다.
// 하던 업무·저장한 계획·연결 확인 주소로 바로 온 경우는 그 화면을 가리지 않게 열지 않는다.
export function guideAutoOpen(hash: string): boolean {
  return /^(#\/?(work)?)?$/.test(hash) && !guideSeen()
}

export function markGuideSeen() {
  try {
    window.localStorage.setItem(SEEN_KEY, '1')
  } catch {
    // 기록하지 못하면 다음 방문에 한 번 더 보일 뿐이다.
  }
}
