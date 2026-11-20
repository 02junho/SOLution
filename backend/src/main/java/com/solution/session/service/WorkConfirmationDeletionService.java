package com.solution.session.service;

import java.util.Map;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;

/** 저장한 계획만 삭제한다. 업무 대화·입력 버전·계산 결과는 유지한다. */
@Service
public class WorkConfirmationDeletionService {
	private final ConfirmationListRepository repository;
	private final SessionRepository sessions;
	private final CurrentOwner owner;

	public WorkConfirmationDeletionService(ConfirmationListRepository repository, SessionRepository sessions, CurrentOwner owner) {
		this.repository = repository;
		this.sessions = sessions;
		this.owner = owner;
	}

	@Transactional
	public ApiResponse<Map<String, Object>> delete(long confirmationId) {
		var initial = repository.findDetail(confirmationId, owner.key())
				.orElseThrow(() -> ApiException.notFound("CONFIRMATION_NOT_FOUND", "저장한 계획을 찾을 수 없습니다."));
		sessions.lockSession(initial.sessionId());
		var current = repository.findDetail(confirmationId, owner.key())
				.orElseThrow(() -> ApiException.notFound("CONFIRMATION_NOT_FOUND", "저장한 계획을 찾을 수 없습니다."));
		if (repository.delete(confirmationId, owner.key()) != 1) throw ApiException.notFound("CONFIRMATION_NOT_FOUND", "저장한 계획을 찾을 수 없습니다.");
		repository.restoreResultStep(current.sessionId(), current.inputVersionId());
		return ApiResponse.ok(Map.of("confirmation_id", confirmationId, "result_id", current.resultId()));
	}
}
