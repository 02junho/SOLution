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

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;
import com.solution.operation.dto.OperationRunRequest;
import com.solution.operation.service.OperationResultService;

import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/v1/operation")
public class OperationResultController {

	private final OperationResultService service;

	public OperationResultController(OperationResultService service) {
		this.service = service;
	}

	@PostMapping("/sessions/{sessionId}/results")
	public ApiResponse<Map<String, Object>> run(@PathVariable long sessionId,
			@Valid @RequestBody OperationRunRequest body,
			@RequestHeader(value = AiServerClient.REQUEST_KEY_HEADER, required = false) String requestedKey,
			HttpServletResponse response) {
		String key = requestedKey == null || requestedKey.isBlank() ? AiServerClient.newRequestKey() : requestedKey;
		response.setHeader(AiServerClient.REQUEST_KEY_HEADER, key);
		return service.run(sessionId, body.inputVersionId(), key);
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
