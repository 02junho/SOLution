import type { JsonObject } from '../../../types/workflow'
import { CHOICE_TITLE, minutes, percent, won } from './format'
import './operationWorkspace.css'

const obj = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonObject) : {}
const num = (value: unknown) => (typeof value === 'number' ? value : undefined)

/** 저장한 계획(확정 기록)에서 운영안 요약. 확정 당시 저장된 선택 안의 숫자만 보여 준다. */
export default function OperationConfirmationSummary({ choice }: { choice: JsonObject }) {
  const key = typeof choice.choice_key === 'string' ? choice.choice_key : ''
  const metrics = obj(choice.metrics)
  return (
    <div className="opw-confirm-summary">
      <p className="opw-confirm-title">
        확정한 안 <b>{CHOICE_TITLE[key as keyof typeof CHOICE_TITLE] ?? key}</b>
      </p>
      <dl className="opw-rows">
        <div>
          <dt>주문 후 음료 받기까지 평균</dt>
          <dd>{minutes(num(metrics.post_order_wait_mean_seconds))}</dd>
        </div>
        <div>
          <dt>5분 넘게 기다린 손님</dt>
          <dd>{percent(num(metrics.post_order_wait_over_300_ratio))}</dd>
        </div>
        <div>
          <dt>하루 직원 인건비</dt>
          <dd>{won(num(choice.cash_cost_krw))}</dd>
        </div>
        <div>
          <dt>현재 방식 대비 추가</dt>
          <dd>{key === 'CURRENT' ? '기준' : won(num(choice.additional_cash_cost_krw))}</dd>
        </div>
      </dl>
      <p className="muted">배치표·대기열 재생은 해당 업무의 결과 화면에서 다시 볼 수 있어요.</p>
    </div>
  )
}
