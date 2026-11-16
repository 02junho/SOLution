package com.solution.session.dto;

import java.time.OffsetDateTime;
import java.util.List;

/**
 * GET /api/v1/work-sessions 응답 — 매장의 과거·진행 업무를 최신순으로 보여준다(이어하기·기록 화면, URQ-FLW-007).
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>next_cursor는 다음 페이지 요청에 그대로 돌려보내는 불투명 커서다. 더 없으면 null.
 */
public record WorkSessionListResponse(List<Item> items, String nextCursor) {

	/** 목록 한 줄. 대화·결과 상세는 넣지 않고 화면 카드에 필요한 요약만 담는다. */
	public record Item(long sessionId, String featureType, String title, String step, int currentVersion,
			OffsetDateTime updatedAt) {
	}
}
