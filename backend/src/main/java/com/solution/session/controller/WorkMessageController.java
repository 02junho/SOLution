package com.solution.session.controller;

import java.util.Map;

import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.MessageHistoryResponse;
import com.solution.session.service.MessageHistoryException;
import com.solution.session.service.WorkMessageService;

@RestController
@RequestMapping("/api/v1/work-sessions")
public class WorkMessageController {

	private final WorkMessageService service;

	public WorkMessageController(WorkMessageService service) {
		this.service = service;
	}

	@GetMapping("/{sessionId}/messages")
	public ApiResponse<MessageHistoryResponse> list(@PathVariable long sessionId,
			@RequestParam(required = false) String cursor, @RequestParam(defaultValue = "50") int size) {
		return service.list(sessionId, cursor, size);
	}

	@ExceptionHandler(MessageHistoryException.class)
	public ResponseEntity<ApiResponse<Map<String, Object>>> handleMissingSession(MessageHistoryException e) {
		return ResponseEntity.status(e.getStatus()).body(new ApiResponse<>(ResponseStatus.ERROR,
				Map.of("detail_code", "SESSION_NOT_FOUND"), e.getMessage()));
	}
}
