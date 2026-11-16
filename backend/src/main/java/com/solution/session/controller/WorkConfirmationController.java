package com.solution.session.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
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
}
