package com.solution.operation.controller;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.operation.dto.OperationRunRequest;
import com.solution.operation.service.OperationResultService;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/v1/operation")
public class OperationResultController {

	static final String IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

	private final OperationResultService service;

	public OperationResultController(OperationResultService service) {
		this.service = service;
	}

	/**
	 * 화면이 만든 Idempotency-Key(필수)로 같은 실행의 재전송을 알아본다 (현식 API v0.4).
	 * FastAPI로 가는 내부 X-Request-Key는 이 키에 단계 이름을 붙여 Spring이 만든다.
	 */
	@PostMapping("/sessions/{sessionId}/results")
	public ApiResponse<Map<String, Object>> run(@PathVariable long sessionId,
			@Valid @RequestBody OperationRunRequest body,
			@RequestHeader(value = IDEMPOTENCY_KEY_HEADER, required = false) String idempotencyKey) {
		return service.run(sessionId, body.inputVersionId(), idempotencyKey);
	}

	@GetMapping("/results/{resultId}")
	public ApiResponse<Map<String, Object>> result(@PathVariable long resultId,
			@RequestParam(defaultValue = "summary") String view) {
		return service.result(resultId, view);
	}

	@GetMapping("/results/{resultId}/traces/{logId}")
	public ApiResponse<Map<String, Object>> trace(@PathVariable long resultId, @PathVariable long logId) {
		return service.trace(resultId, logId);
	}
}
