package com.solution.session.service;

import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;

/** 표시 이력 삭제. 입력 버전·계산 결과·확정 계획과 이벤트 재전송 정보는 보존한다. */
@Service
public class WorkDeletionService {
	private final CalculationRuns runs;
	private final SessionRepository repository;
	private final CurrentOwner currentOwner;

	public WorkDeletionService(SessionRepository repository, CurrentOwner currentOwner, CalculationRuns runs) {
		this.runs = runs;
		this.repository = repository;
		this.currentOwner = currentOwner;
	}

	private void requireSession(long sessionId) {
		var row = repository.findSessionContext(sessionId)
				.filter(session -> session.ownerKey().equals(currentOwner.key()))
				.orElseThrow(() -> ApiException.notFound("SESSION_NOT_FOUND", "업무를 찾을 수 없습니다."));
		if ("running".equals(row.step()) || repository.hasActiveOperationRuns(sessionId) || runs.active(sessionId)) {
			throw ApiException.badRequest("SESSION_RUNNING", "계산이 끝난 뒤 삭제해 주세요.");
		}
	}

	@Transactional
	public ApiResponse<Map<String, Object>> deleteSession(long sessionId) {
		repository.lockSession(sessionId);
		runs.recover(sessionId);
		requireSession(sessionId);
		repository.deleteSession(sessionId);
		return ApiResponse.ok(Map.of("session_id", sessionId));
	}

}
