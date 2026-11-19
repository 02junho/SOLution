package com.solution.session.controller;

import java.util.Map;

import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.session.service.WorkConfirmationDeletionService;

@RestController
public class WorkConfirmationDeletionController {
	private final WorkConfirmationDeletionService service;

	public WorkConfirmationDeletionController(WorkConfirmationDeletionService service) {
		this.service = service;
	}

	@DeleteMapping("/api/v1/work-confirmations/{confirmationId}")
	public ApiResponse<Map<String, Object>> delete(@PathVariable String confirmationId) {
		try {
			long id = Long.parseLong(confirmationId);
			if (id > 0) return service.delete(id);
		} catch (NumberFormatException ignored) {
			// 숫자 형식 오류를 공통 요청 오류로 처리한다.
		}
		throw ApiException.badRequest("저장 번호는 양의 정수여야 합니다.");
	}
}
