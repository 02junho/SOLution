package com.solution.session.controller;

import java.util.Map;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.session.service.WorkDeletionService;

@RestController
@RequestMapping("/api/v1/work-sessions")
public class WorkDeletionController {
	private final WorkDeletionService service;

	public WorkDeletionController(WorkDeletionService service) {
		this.service = service;
	}

	@DeleteMapping("/{sessionId}")
	public ApiResponse<Map<String, Object>> deleteSession(@PathVariable String sessionId) {
		return service.deleteSession(id(sessionId));
	}

	@DeleteMapping("/{sessionId}/messages/{messageId}")
	public ApiResponse<Map<String, Object>> deleteMessage(@PathVariable String sessionId,
			@PathVariable String messageId) {
		return service.deleteMessage(id(sessionId), id(messageId));
	}

	private long id(String value) {
		try {
			long id = Long.parseLong(value);
			if (id > 0) return id;
		} catch (NumberFormatException ignored) {
			// 공통 500 오류 대신 잘못된 요청으로 처리한다.
		}
		throw ApiException.badRequest("업무·대화 번호는 양의 정수여야 합니다.");
	}
}
