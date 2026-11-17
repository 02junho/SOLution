package com.solution.session.controller;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.WorkConfirmationDetailResponse;
import com.solution.session.service.ConfirmationNotFoundException;
import com.solution.session.dto.WorkConfirmationListResponse;
import com.solution.session.service.WorkConfirmationService;

@RestController
@RequestMapping("/api/v1/work-confirmations")
public class WorkConfirmationController {

	private final WorkConfirmationService service;

	public WorkConfirmationController(WorkConfirmationService service) {
		this.service = service;
	}

	@GetMapping
	public ApiResponse<WorkConfirmationListResponse> list(
			@RequestParam(name = "feature_type", required = false) String featureType,
			@RequestParam(name = "session_id", required = false) Long sessionId,
			@RequestParam(required = false) String cursor, @RequestParam(defaultValue = "20") int size) {
		return service.list(featureType, sessionId, cursor, size);
	}
	@GetMapping("/{confirmationId}")
	public ApiResponse<WorkConfirmationDetailResponse> get(@PathVariable long confirmationId) {
		return service.getDetail(confirmationId);
	}

	@ExceptionHandler(ConfirmationNotFoundException.class)
	public ResponseEntity<ApiResponse<Map<String, Object>>> handleMissing(ConfirmationNotFoundException e) {
		return ResponseEntity.status(e.getStatus()).body(new ApiResponse<>(ResponseStatus.ERROR,
				Map.of("detail_code", "CONFIRMATION_NOT_FOUND"), e.getMessage()));
	}

}
