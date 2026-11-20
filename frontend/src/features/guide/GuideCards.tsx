import { useEffect, useState } from 'react'
import { Icon, Modal } from '../../components/common/Ui'
import { GUIDE_SLIDES } from './guideSlides'
import './guide.css'

// 처음 쓰는 사장님용 사용법 카드 4장. 헤더의 "사용법"으로 언제든 다시 연다.
export default function GuideCards({
  onClose,
  onStart,
}: {
  onClose: () => void
  onStart: () => void
}) {
  const [index, setIndex] = useState(0)
  const last = GUIDE_SLIDES.length - 1
  const slide = GUIDE_SLIDES[index]

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowRight') setIndex((i) => Math.min(i + 1, last))
      if (e.key === 'ArrowLeft') setIndex((i) => Math.max(i - 1, 0))
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [last])

  return (
    <Modal
      title="SOL루션 사용법"
      description="네 장만 넘겨 보세요. 언제든 위의 '사용법'에서 다시 볼 수 있어요."
      onClose={onClose}
      wide
      closeOnBackdrop
    >
      <div className="guide">
        {/* 카드가 바뀔 때 화면 낭독기에 번호와 제목을 알린다. 교체되는 카드 밖에 두어 늘 같은 영역으로 남긴다. */}
        <p className="sr-only" aria-live="polite">
          {`${index + 1} / ${GUIDE_SLIDES.length} ${slide.eyebrow}: ${slide.title.replace(/\n/g, ' ')}`}
        </p>
        <section
          className="guide-slide"
          key={slide.key}
          aria-roledescription="카드"
          aria-label={`${index + 1} / ${GUIDE_SLIDES.length} ${slide.eyebrow}`}
        >
          <p className="guide-eyebrow">
            <span>
              {index + 1} / {GUIDE_SLIDES.length}
            </span>
            {slide.eyebrow}
          </p>
          <h3 className="guide-title">{slide.title}</h3>
          <SlideBody slideKey={slide.key} />
        </section>

        <div className="guide-dots" role="group" aria-label="카드 고르기">
          {GUIDE_SLIDES.map((s, i) => (
            <button
              type="button"
              key={s.key}
              className={i === index ? 'active' : ''}
              aria-label={`${i + 1}번째 카드: ${s.eyebrow}`}
              aria-current={i === index ? 'step' : undefined}
              onClick={() => setIndex(i)}
            />
          ))}
        </div>

        <div className="guide-footer">
          <button
            type="button"
            className="button secondary"
            onClick={() => (index === 0 ? onClose() : setIndex(index - 1))}
          >
            {index === 0 ? '건너뛰기' : '이전'}
          </button>
          {/* 한 버튼을 계속 쓴다. 마지막 장에서 글자만 바뀌어 누른 뒤에도 포커스가 버튼에 남는다. */}
          <button
            type="button"
            className="button primary"
            onClick={() => (index < last ? setIndex(index + 1) : onStart())}
          >
            {index < last ? '다음' : '첫 업무 시작하기'} <Icon name="arrow" size={18} />
          </button>
        </div>
      </div>
    </Modal>
  )
}

function SlideBody({ slideKey }: { slideKey: string }) {
  if (slideKey === 'what')
    return (
      <div className="guide-tiles">
        <div className="guide-tile">
          <span className="guide-tile-icon">
            <Icon name="box" size={26} />
          </span>
          <strong>매입·재고</strong>
          <p>이번 주에 무엇을, 어느 거래처에서, 얼마나 살지 조건에 맞게 가장 싸게 정해 줘요.</p>
        </div>
        <div className="guide-tile">
          <span className="guide-tile-icon">
            <Icon name="clock" size={26} />
          </span>
          <strong>운영 실험</strong>
          <p>
            바쁜 시간에 지금 인원 그대로 · 서로 돕기 · 한 명 추가, 세 가지를 미리 돌려 보고 대기시간과
            인건비를 비교해요.
          </p>
        </div>
      </div>
    )

  if (slideKey === 'steps')
    return (
      <ol className="guide-steps">
        <li>
          <strong>조건 알려 주기</strong>
          <span>말로 하거나 폼에 직접 적어요.</span>
        </li>
        <li>
          <strong>조건 확인</strong>
          <span>정리한 조건을 보고 맞으면 확인을 눌러요.</span>
        </li>
        <li>
          <strong>계산</strong>
          <span>계산 프로그램이 안을 만들어요.</span>
        </li>
        <li>
          <strong>비교</strong>
          <span>안을 나란히 보고 쉬운 설명을 읽어요.</span>
        </li>
        <li>
          <strong>저장</strong>
          <span>마음에 드는 안만 골라 저장해요.</span>
        </li>
      </ol>
    )

  if (slideKey === 'talk')
    return (
      <>
        <ul className="guide-quotes">
          <li>
            <small>매입</small>
            <Icon name="chat" size={20} />
            "이번 주 매입 준비해 줘. 예산은 15만 원이야"
          </li>
          <li>
            <small>운영</small>
            <Icon name="chat" size={20} />
            "하루 150건 정도, 사장님도 같이 일해요"
          </li>
          <li>
            <small>바꾸기</small>
            <Icon name="chat" size={20} />
            "예산을 10만 원으로 줄여 줘"
          </li>
        </ul>
        <p className="guide-note">
          모르는 값은 SOL루션이 다시 물어봐요. 말 대신 폼으로 넣어도 돼요.
        </p>
      </>
    )

  return (
    <ul className="guide-checks">
      <li>
        <Icon name="check" size={20} />
        숫자는 계산 프로그램이 내고, AI는 말을 정리하고 결과를 설명만 해요.
      </li>
      <li>
        <Icon name="check" size={20} />
        실제 주문·결제·근무표 적용은 하지 않아요. 계획 저장까지만 해요.
      </li>
      <li>
        <Icon name="check" size={20} />
        운영 결과는 모의 조건이에요. 시간대별 손님 비중은 을지로입구 상권 카드 결제 기준 가정이에요.
      </li>
      <li>
        <Icon name="check" size={20} />
        하던 업무는 "이어하기", 저장한 계획은 위의 "저장한 계획"에서 다시 볼 수 있어요.
      </li>
    </ul>
  )
}
