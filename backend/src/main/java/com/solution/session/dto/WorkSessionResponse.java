package com.solution.session.dto;

import java.time.OffsetDateTime;

/**
 * 업무 시작 응답. JSON은 Jackson 설정으로 snake_case(session_id 등)로 나간다.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>첫 입력 버전(work_version)은 아직 만들지 않는다. 실제 입력이 구조화되는 events 단계에서 생긴다(HW-F01).
 */
public record WorkSessionResponse(
		long sessionId,
		long storeId,
		String featureType,
		String inputMethod,
		String title,
		int currentVersion,
		String step,
		OffsetDateTime createdAt) {
}
