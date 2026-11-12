package com.solution.session.service;

import java.time.OffsetDateTime;

import org.springframework.stereotype.Service;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkSessionCreateRequest;
import com.solution.session.dto.WorkSessionResponse;

/**
 * 업무(세션) 시작 처리. 흐름: 화면 → Spring(work_session 생성) → 화면. 이 단계에서는 AI·계산을 부르지 않는다.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>store_id는 요청 값만 믿지 않고 owner_key로 소유권을 확인한다(GR-01). 없는 매장·남의 매장은 404로 숨긴다.
 */
@Service
public class WorkSessionService {

	static final String STORE_NOT_FOUND = "매장을 찾을 수 없습니다.";
	private static final String STEP_INPUT = "input";
	private static final int FIRST_VERSION = 1;

	private final SessionRepository repository;
	private final CurrentOwner currentOwner;
	private final IdGenerator idGenerator;

	public WorkSessionService(SessionRepository repository, CurrentOwner currentOwner, IdGenerator idGenerator) {
		this.repository = repository;
		this.currentOwner = currentOwner;
		this.idGenerator = idGenerator;
	}

	/** 새 업무를 만든다. current_version=1, step='input'로 시작하고, 첫 입력 버전은 events 단계에서 만든다. */
	public ApiResponse<WorkSessionResponse> create(WorkSessionCreateRequest request) {
		// 소유권 확인: 매장이 없거나 내 매장이 아니면 404로 숨긴다(권한 없음을 403으로 드러내지 않음).
		String ownerKey = repository.findStoreOwnerKey(request.storeId())
				.filter(owner -> owner.equals(currentOwner.key()))
				.orElseThrow(() -> ApiException.notFound(STORE_NOT_FOUND));

		long sessionId = idGenerator.next();
		String title = resolveTitle(request.title(), request.featureType());
		OffsetDateTime now = OffsetDateTime.now();

		repository.insertSession(sessionId, request.storeId(), request.featureType(), request.inputMethod(),
				title, FIRST_VERSION, STEP_INPUT, now);

		WorkSessionResponse data = new WorkSessionResponse(sessionId, request.storeId(), request.featureType(),
				request.inputMethod(), title, FIRST_VERSION, STEP_INPUT, now);
		return ApiResponse.ok(data);
	}

	/** 제목을 비워 보내면 기능에 맞는 기본 제목을 넣어 준다. */
	private String resolveTitle(String requested, String featureType) {
		if (requested != null && !requested.isBlank()) {
			return requested;
		}
		return "operation".equals(featureType) ? "오늘 운영 준비" : "이번 주 매입 준비";
	}
}
