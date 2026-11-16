package com.solution.session.controller;

import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.ResponseEntity;
import org.springframework.http.HttpStatus;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
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

	private static final Logger log = LoggerFactory.getLogger(WorkResultController.class);
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
	@ExceptionHandler({MethodArgumentNotValidException.class, HttpMessageNotReadableException.class,
			MethodArgumentTypeMismatchException.class})
	public ResponseEntity<ApiResponse<Map<String, Object>>> handleInvalidRequest(Exception e) {
		return ResponseEntity.badRequest().body(new ApiResponse<>(ResponseStatus.ERROR,
				Map.of("detail_code", "INVALID_REQUEST"), "요청 값의 형식을 확인해 주세요."));
	}

	@ExceptionHandler(Exception.class)
	public ResponseEntity<ApiResponse<Map<String, Object>>> handleUnexpected(Exception e) {
		log.error("확정 저장 실패");
		return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(new ApiResponse<>(ResponseStatus.ERROR,
				Map.of("detail_code", "INTERNAL_ERROR"), "저장 중 오류가 발생했습니다."));
	}

}
