package com.solution.session.controller;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.ConfirmInputRequest;
import com.solution.session.dto.ConfirmInputResponse;
import com.solution.session.service.InputConfirmException;
import com.solution.session.service.WorkVersionService;

import jakarta.validation.Valid;

@RestController
@RequestMapping("/api/v1/work-versions")
public class WorkVersionController {

	private final WorkVersionService service;

	public WorkVersionController(WorkVersionService service) {
		this.service = service;
	}

	@PostMapping("/{inputVersionId}/confirm-input")
	public ApiResponse<ConfirmInputResponse> confirmInput(@PathVariable long inputVersionId,
			@Valid @RequestBody(required = false) ConfirmInputRequest request) {
		return service.confirmInput(inputVersionId, request);
	}

	@ExceptionHandler(InputConfirmException.class)
	public ResponseEntity<ApiResponse<Map<String, Object>>> handleInputConfirm(InputConfirmException e) {
		return ResponseEntity.status(e.getStatus()).body(new ApiResponse<>(ResponseStatus.ERROR,
				Map.of("detail_code", e.getDetailCode()), e.getMessage()));
	}
}
