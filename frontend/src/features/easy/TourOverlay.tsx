// 따라 하며 배우기: 지금 할 곳만 밝게 비추고 옆에 큰 말풍선으로 안내한다.
// 화면을 막지 않는다(비춘 곳 밖을 눌러도 동작한다). 움직이는 효과 없이 멈춘 강조와 글만 쓴다.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { TourStep } from './tour'
import { TOUR_TOTAL } from './tour'

type Box = { top: number; left: number; width: number; height: number }
const PAD = 8
const BUBBLE_WIDTH = 380

function measure(target: string): Box | null {
  const el = document.querySelector(`[data-tour="${target}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  return { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 }
}

export default function TourOverlay({ step, number, onNext, onPrev, onClose }: { step: TourStep; number: number; onNext: () => void; onPrev?: () => void; onClose: () => void }) {
  const [box, setBox] = useState<Box | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const [bubbleH, setBubbleH] = useState(240)
  // 화면 크기도 상태로 둔다. 비춘 곳 위치가 그대로여도 창 높이만 바뀌면 말풍선 자리를 다시 잡아야 한다.
  const [view, setView] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }))
  // 말풍선 실제 높이로 자리를 잡는다(어림값으로 잡으면 비춘 곳 제목을 가린다).
  // 같은 단계에서도 창 폭이 줄면 글이 여러 줄로 늘어나므로 말풍선 크기 변화를 지켜본다.
  useLayoutEffect(() => {
    const el = bubbleRef.current
    if (!el) return
    const read = () => { const h = el.offsetHeight; if (h) setBubbleH((prev) => (prev === h ? prev : h)) }
    read()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(read)
    observer.observe(el)
    return () => observer.disconnect()
  }, [step.key, number])

  // 단계가 바뀌면 비출 곳을 화면 가운데로 가져온다.
  useEffect(() => {
    const el = document.querySelector(`[data-tour="${step.target}"]`)
    el?.scrollIntoView({ block: 'center', behavior: 'auto' })
  }, [step.target])

  // 스크롤·크기 변화·화면 내용 변화에 맞춰 위치를 다시 잰다.
  useLayoutEffect(() => {
    let frame = 0
    const update = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const w = window.innerWidth
        const h = window.innerHeight
        setView((prev) => (prev.w === w && prev.h === h ? prev : { w, h }))
        const next = measure(step.target)
        // 같은 위치면 그대로 둔다(다시 그리기를 멈춰 관찰기와 서로 부르지 않게).
        setBox((prev) => prev && next && prev.top === next.top && prev.left === next.left && prev.width === next.width && prev.height === next.height ? prev : next)
      })
    }
    update()
    window.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    const observer = new MutationObserver(update)
    observer.observe(document.body, { childList: true, subtree: true, attributes: true })
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
      observer.disconnect()
    }
  }, [step.target])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const viewW = view.w
  const viewH = view.h
  const width = Math.min(BUBBLE_WIDTH, viewW - 32)
  // 말풍선 자리: 비춘 곳 아래 → 위 → 오른쪽 → 왼쪽 → (다 안 되면) 화면 아래. 비춘 곳을 가리지 않는 쪽을 먼저 고른다.
  const gap = 12
  let top = viewH - bubbleH - 16
  let left = (viewW - width) / 2
  if (box) {
    const clampTop = (t: number) => Math.min(Math.max(16, t), viewH - bubbleH - 16)
    if (box.top + box.height + gap + bubbleH < viewH - 16) {
      top = box.top + box.height + gap
      left = Math.min(Math.max(16, box.left), viewW - width - 16)
    } else if (box.top - gap - bubbleH > 16) {
      top = box.top - gap - bubbleH
      left = Math.min(Math.max(16, box.left), viewW - width - 16)
    } else if (box.left + box.width + gap + width < viewW - 16) {
      left = box.left + box.width + gap
      top = clampTop(box.top)
    } else if (box.left - gap - width > 16) {
      left = box.left - gap - width
      top = clampTop(box.top)
    }
  }

  return (
    <div className="easy-tour" aria-live="polite">
      {box && (
        <div className="easy-tour-spot" style={{ top: box.top, left: box.left, width: box.width, height: box.height }} aria-hidden />
      )}
      <div ref={bubbleRef} className="easy-tour-bubble" role="dialog" aria-label={`따라 하며 배우기 ${number}/${TOUR_TOTAL}단계`} style={{ top, left, width }}>
        <p className="easy-tour-count">따라 하며 배우기 · {number} / {TOUR_TOTAL}</p>
        <h2>{step.title}</h2>
        <p>{step.body}</p>
        <div className="easy-tour-actions">
          {/* 직접 해야 하는 단계는 안내를 한 줄로 먼저, 버튼(이전·그만 보기)은 그 아래 한 줄에 */}
          {step.waitsForAction && <span className="easy-tour-wait">직접 해 보세요</span>}
          {onPrev && <button type="button" className="easy-secondary" onClick={onPrev}>← 이전</button>}
          {!step.waitsForAction && (
            <button type="button" className="easy-primary" onClick={onNext}>{number === TOUR_TOTAL ? '끝내기' : '다음'}</button>
          )}
          <button type="button" className="easy-secondary" onClick={onClose}>그만 보기</button>
        </div>
      </div>
    </div>
  )
}
