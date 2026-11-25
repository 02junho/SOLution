package com.solution.session.dto;

import java.util.Map;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

/**
 * POST /api/v1/work-sessions/{session_id}/events 요청 본문 — 사장님의 한 번의 입력.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>event_type에 따라 필요한 값이 다르다: message→content, form→form_input, question_reply→question_id+answer.
 * 타입별 필수값은 서비스가 검사한다(없으면 400).
 */
public record WorkSessionEventRequest(
		@NotNull @Pattern(regexp = "message|form|question_reply",
				message = "message, form, question_reply 중 하나여야 합니다.") String eventType,
		Long baseVersionId,
		String content,
		Map<String, Object> formInput,
		String questionId,
		Object answer) {
}
