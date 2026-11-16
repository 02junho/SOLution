package com.solution.session.service;

import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Base64;

import org.springframework.stereotype.Service;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkConfirmationListResponse;

@Service
public class WorkConfirmationService {

	private final ConfirmationListRepository repository;
	private final CurrentOwner owner;

	public WorkConfirmationService(ConfirmationListRepository repository, CurrentOwner owner) {
		this.repository = repository;
		this.owner = owner;
	}

	public ApiResponse<WorkConfirmationListResponse> list(String featureType, Long sessionId, String cursor, int size) {
		if (featureType != null && !"purchase".equals(featureType) && !"operation".equals(featureType)) {
			throw ApiException.badRequest("feature_type은 purchase 또는 operation이어야 합니다.");
		}
		if (sessionId != null && sessionId <= 0) {
			throw ApiException.badRequest("session_id는 양의 정수여야 합니다.");
		}
		// 기존 업무 목록과 동일하게 기본 20, 최대 100으로 보정한다.
		int limit = size <= 0 ? 20 : Math.min(size, 100);
		Cursor decoded = decode(cursor);
		var rows = repository.find(owner.key(), featureType, sessionId,
				decoded == null ? null : decoded.confirmedAt(), decoded == null ? null : decoded.confirmationId(), limit + 1);
		boolean hasNext = rows.size() > limit;
		var page = hasNext ? rows.subList(0, limit) : rows;
		String next = null;
		if (hasNext) {
			var last = page.getLast();
			String raw = last.confirmedAt().toString() + "," + last.confirmationId();
			next = Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
		}
		return ApiResponse.ok(new WorkConfirmationListResponse(page, next));
	}

	private record Cursor(OffsetDateTime confirmedAt, long confirmationId) {
	}

	private Cursor decode(String cursor) {
		if (cursor == null || cursor.isBlank()) { return null; }
		try {
			if (cursor.length() > 256) { throw new IllegalArgumentException(); }
			String raw = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
			int comma = raw.lastIndexOf(',');
			OffsetDateTime time = OffsetDateTime.parse(raw.substring(0, comma));
			long id = Long.parseLong(raw.substring(comma + 1));
			if (id <= 0) { throw new IllegalArgumentException(); }
			return new Cursor(time, id);
		}
		catch (RuntimeException e) {
			throw ApiException.badRequest("커서가 올바르지 않습니다.");
		}
	}
}
