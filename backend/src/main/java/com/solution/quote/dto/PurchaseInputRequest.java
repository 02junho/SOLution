package com.solution.quote.dto;

import java.util.List;
import java.util.Map;

import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;

/**
 * 견적 화면의 "이 견적으로 구매안 만들기" 요청. 작성: 신준호 (구매 최적화)
 *
 * <p>store_id는 구매 업무를 만들 매장(work_session.store_id)이다. 견적 쪽 매장 ID(경로의 storeId)는
 * 테스트용 문자열일 수 있어 따로 받는다. 소유권은 업무를 만들 때 서버가 다시 확인한다.
 * conditions(planning_days·budget_krw·max_delivery_count)는 선택이다. 비우면 업무 화면이 질문으로 받는다.
 */
public record PurchaseInputRequest(
		@NotNull Long storeId,
		@NotEmpty List<String> quoteBatchIds,
		Map<String, Object> conditions) {
}
