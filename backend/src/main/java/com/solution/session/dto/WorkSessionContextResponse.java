package com.solution.session.dto;

import java.time.OffsetDateTime;

/**
 * GET /api/v1/work-sessions/{session_id} 응답 — 중단했던 업무를 다시 열 때 복원할 문맥.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>대화 본문은 넣지 않는다(큰 본문 분리). 대화는 /messages 에서 따로 읽는다.
 * input_confirmed = 현재 입력 버전에 input_confirmed_at 이 있으면 true(계산 가능), 없으면 false.
 */
public record WorkSessionContextResponse(
		long sessionId,
		long storeId,
		String featureType,
		String inputMethod,
		String title,
		int currentVersion,
		Long currentVersionId,
		boolean inputConfirmed,
		String step,
		Long latestResultId,
		boolean hasConfirmation,
		OffsetDateTime createdAt,
		OffsetDateTime updatedAt) {
}
