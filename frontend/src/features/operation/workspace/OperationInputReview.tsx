import type { JsonObject } from '../../../types/workflow'
import { DAY_HOURS, readOperationDraft, readOperationInput, rushLength, rushText } from './operationInput'
import { won } from './format'

/** 업무 화면 01 · 계산 전 조건 확인(운영). 저장된 입력에서 사장님이 확인할 핵심만 보여 준다. */
export default function OperationInputReview({ input, confirmed }: { input: JsonObject | null; confirmed: boolean }) {
  const saved = readOperationInput(input)
  const draft = saved ? null : readOperationDraft(input)
  if (draft) {
    // 대화로 채우는 중: 채운 값과 "확인 필요"를 보여 주고, 남은 값은 대화나 폼으로 받는다.
    const need = '확인 필요'
    return (
      <>
        <div className="review-totals">
          <div>
            <small>하루 주문</small>
            <b className={draft.dailyOrders === null ? 'opw-need' : ''}>
              {draft.dailyOrders === null ? need : `${draft.dailyOrders.toLocaleString('ko-KR')}건`}
            </b>
          </div>
          <div>
            <small>일하는 사람</small>
            <b className={draft.isOwnerWorking === null ? 'opw-need' : ''}>
              {draft.isOwnerWorking === null ? need : draft.isOwnerWorking ? '사장님 + 직원 1명' : '직원 2명'}
            </b>
          </div>
          <div>
            <small>직원 시급</small>
            <b className={draft.hourlyWage === null ? 'opw-need' : ''}>
              {draft.hourlyWage === null ? need : won(draft.hourlyWage)}
            </b>
          </div>
        </div>
        <p className="opw-next" role="status">
          다음으로 알려 주세요:{' '}
          <b>
            {draft.dailyOrders === null
              ? '하루에 주문이 몇 건 정도 들어오나요?'
              : draft.isOwnerWorking === null
                ? '사장님도 매장에서 직접 일하시나요?'
                : '직원 시급은 얼마인가요?'}
          </b>
        </p>
        <p className="muted opw-review-note">다 채우면 세 운영안을 비교할 수 있어요. 폼으로 넣어도 돼요.</p>
      </>
    )
  }
  if (!saved) {
    return (
      <p className="muted">
        {confirmed
          ? '저장된 조건이 있어요. "세 운영안 비교하기"를 누르면 그 조건으로 계산해요. 조건을 바꾸려면 "조건 수정"을 눌러 주세요.'
          : '아직 조건이 없어요. "폼으로 직접 입력"에서 조건을 넣어 주세요.'}
      </p>
    )
  }
  const staff = saved.isOwnerWorking ? '사장님 + 직원 1명' : '직원 2명'
  return (
    <>
      <div className="review-totals">
        <div>
          <small>하루 주문</small>
          <b>{saved.dailyOrders.toLocaleString('ko-KR')}건</b>
        </div>
        <div>
          <small>라스트 오더</small>
          <b>{saved.lastOrderTime}</b>
        </div>
        <div>
          <small>일하는 사람</small>
          <b>{staff}</b>
        </div>
        <div>
          <small>직원 시급</small>
          <b>{won(saved.hourlyWage)}</b>
        </div>
      </div>
      <ul className="opw-review-plans">
        <li>
          <b>현재 방식</b>
          <span>
            {staff} {DAY_HOURS}, 각자 맡은 일만
          </span>
        </li>
        <li>
          <b>서로 돕기</b>
          <span>같은 사람·시간, {rushText(saved.rush)}에만 서로 도움</span>
        </li>
        <li>
          <b>한 명 추가</b>
          <span>
            {rushText(saved.rush)}에 직원 1명 더 ({rushLength(saved.rush)})
          </span>
        </li>
      </ul>
      <p className="muted opw-review-note">
        시간대별 손님은 을지로입구 상권 비중으로 나누고, 처리시간은 가정값이에요. 같은 손님 조건으로 30번 돌려 비교해요.
        바쁜 시간·라스트 오더는 "바쁜 시간 12시~3시"처럼 말로도 바꿀 수 있어요.
      </p>
    </>
  )
}
