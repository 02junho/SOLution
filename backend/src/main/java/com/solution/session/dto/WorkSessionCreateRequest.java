package com.solution.session.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/**
 * POST /api/v1/work-sessions 요청 본문. 업무(세션)를 시작할 때 화면이 보내는 값.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>store_id의 소유권은 요청 값을 믿지 않고 서버가 다시 확인한다(GR-01). 숫자 계산·AI 호출은 이 단계에서 하지 않는다.
 */
public record WorkSessionCreateRequest(
		@NotNull Long storeId,
		@NotNull @Pattern(regexp = "purchase|operation", message = "purchase 또는 operation이어야 합니다.") String featureType,
		@NotNull @Pattern(regexp = "agent|form", message = "agent 또는 form이어야 합니다.") String inputMethod,
		String title) {
}
