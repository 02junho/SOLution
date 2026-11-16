package com.solution.session.controller;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.ConfirmResultRequest;
import com.solution.session.dto.ConfirmResultResponse;
import com.solution.session.service.ResultConfirmException;
import com.solution.session.service.WorkResultConfirmService;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/v1/work-results")
public class WorkResultController {

	private final WorkResultConfirmService service;

	public WorkResultController(WorkResultConfirmService service) {
		this.service = service;
	}

	@PostMapping("/{resultId}/confirm")
	public ApiResponse<ConfirmResultResponse> confirm(@PathVariable long resultId,
			@RequestHeader(name = "Idempotency-Key", required = false) String key,
			@Valid @RequestBody ConfirmResultRequest request) {
		return service.confirm(resultId, key, request);
	}

	@ExceptionHandler(ResultConfirmException.class)
	public ResponseEntity<ApiResponse<Map<String, Object>>> handleConfirmation(ResultConfirmException e) {
		return ResponseEntity.status(e.getStatus()).body(new ApiResponse<>(ResponseStatus.ERROR,
				Map.of("detail_code", e.getDetailCode()), e.getMessage()));
	}
}
