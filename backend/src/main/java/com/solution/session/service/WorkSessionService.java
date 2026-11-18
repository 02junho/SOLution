package com.solution.session.service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.List;

import org.springframework.stereotype.Service;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkSessionContextResponse;
import com.solution.session.dto.WorkSessionCreateRequest;
import com.solution.session.dto.WorkSessionListResponse;
import com.solution.session.dto.WorkSessionResponse;
import com.solution.session.service.SessionRepository.SessionContextRow;
import com.solution.session.service.SessionRepository.SessionSummaryRow;

/**
 * 업무(세션) 시작·문맥 복원 처리. 이 단계에서는 AI·계산을 부르지 않는다.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>store_id는 요청 값만 믿지 않고 owner_key로 소유권을 확인한다(GR-01). 없는·남의 매장/업무는 404로 숨긴다.
 */
@Service
public class WorkSessionService {

	static final String STORE_NOT_FOUND = "매장을 찾을 수 없습니다.";
	static final String SESSION_NOT_FOUND = "업무를 찾을 수 없습니다.";
	private static final String STEP_INPUT = "input";
	private static final int FIRST_VERSION = 1;
	private static final int DEFAULT_SIZE = 20;
	private static final int MAX_SIZE = 100;

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

	/**
	 * 중단했던 업무를 다시 열 때 현재 문맥을 복원한다(HW-F01). 없는 업무·남의 매장이면 404로 숨긴다.
	 * input_confirmed는 현재 입력 버전의 input_confirmed_at 유무로 판단한다.
	 */
	public ApiResponse<WorkSessionContextResponse> getContext(long sessionId) {
		SessionContextRow row = repository.findSessionContext(sessionId)
				.filter(context -> context.ownerKey().equals(currentOwner.key()))
				.orElseThrow(() -> ApiException.notFound(SESSION_NOT_FOUND));

		WorkSessionContextResponse data = new WorkSessionContextResponse(
				row.sessionId(), row.storeId(), row.featureType(), row.inputMethod(), row.title(),
				row.currentVersion(), row.currentVersionId(), row.inputConfirmedAt() != null, row.step(),
				row.latestResultId(), row.hasConfirmation(), row.createdAt(), row.updatedAt(), row.currentInputJson());
		return ApiResponse.ok(data);
	}

	/**
	 * 내 매장의 업무를 최신순(updated_at, session_id DESC)으로 보여준다(URQ-FLW-007).
	 * keyset 커서로 페이지를 나눈다. 한 건 더 조회해 다음 페이지 유무를 판단하고, 남으면 next_cursor를 만든다.
	 */
	public ApiResponse<WorkSessionListResponse> list(String featureType, String cursor, int size) {
		if (featureType != null && !"purchase".equals(featureType) && !"operation".equals(featureType)) {
			throw ApiException.badRequest("featureType은 purchase 또는 operation이어야 합니다.");
		}
		int limit = size <= 0 ? DEFAULT_SIZE : Math.min(size, MAX_SIZE);
		Cursor decoded = decodeCursor(cursor);
		OffsetDateTime cursorUpdatedAt = decoded == null ? null : decoded.updatedAt();
		Long cursorSessionId = decoded == null ? null : decoded.sessionId();

		// limit + 1을 읽어 다음 페이지가 있는지 본다.
		List<SessionSummaryRow> rows = repository.findSessions(currentOwner.key(), featureType,
				cursorUpdatedAt, cursorSessionId, limit + 1);

		boolean hasNext = rows.size() > limit;
		List<SessionSummaryRow> page = hasNext ? rows.subList(0, limit) : rows;

		List<WorkSessionListResponse.Item> items = page.stream()
				.map(row -> new WorkSessionListResponse.Item(row.sessionId(), row.featureType(), row.title(),
						row.step(), row.currentVersion(), row.updatedAt()))
				.toList();

		String nextCursor = hasNext ? encodeCursor(page.get(page.size() - 1)) : null;
		return ApiResponse.ok(new WorkSessionListResponse(items, nextCursor));
	}

	/** 커서는 (updated_at, session_id)를 UTF-8 문자열로 이어 Base64(URL)로 감싼 불투명 값이다. */
	private record Cursor(OffsetDateTime updatedAt, long sessionId) {
	}

	private String encodeCursor(SessionSummaryRow row) {
		String raw = row.updatedAt().toString() + "," + row.sessionId();
		return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
	}

	private Cursor decodeCursor(String cursor) {
		if (cursor == null || cursor.isBlank()) {
			return null;
		}
		try {
			String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
			int comma = raw.lastIndexOf(',');
			OffsetDateTime updatedAt = OffsetDateTime.parse(raw.substring(0, comma));
			long sessionId = Long.parseLong(raw.substring(comma + 1));
			return new Cursor(updatedAt, sessionId);
		}
		catch (RuntimeException e) {
			throw ApiException.badRequest("커서가 올바르지 않습니다.");
		}
	}

	/** 제목을 비워 보내면 기능에 맞는 기본 제목을 넣어 준다. */
	private String resolveTitle(String requested, String featureType) {
		if (requested != null && !requested.isBlank()) {
			return requested;
		}
		return "operation".equals(featureType) ? "오늘 운영 준비" : "이번 주 매입 준비";
	}
}
