package com.solution.common.exception;

import java.util.stream.Collectors;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.servlet.resource.NoResourceFoundException;

import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;

/**
 * 예외를 공통 응답 형식으로 바꾼다. 사장님 정보 부족(needs_input)·답 없음(infeasible)은 예외가 아니라
 * 각 서비스가 ApiResponse로 직접 돌려준다. 여기서는 잘못된 요청과 시스템 오류만 다룬다.
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

	private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

	@ExceptionHandler(MethodArgumentNotValidException.class)
	public ResponseEntity<ApiResponse<Void>> handleValidation(MethodArgumentNotValidException e) {
		String message = e.getBindingResult().getFieldErrors().stream()
				.map(error -> error.getField() + ": " + error.getDefaultMessage())
				.collect(Collectors.joining(", "));
		return ResponseEntity.badRequest().body(ApiResponse.error("요청 값이 올바르지 않습니다. " + message));
	}

	@ExceptionHandler(HttpMessageNotReadableException.class)
	public ResponseEntity<ApiResponse<Void>> handleUnreadable(HttpMessageNotReadableException e) {
		return ResponseEntity.badRequest().body(ApiResponse.error("요청 본문을 읽을 수 없습니다."));
	}

	@ExceptionHandler(NoResourceFoundException.class)
	public ResponseEntity<ApiResponse<Void>> handleNotFound(NoResourceFoundException e) {
		return ResponseEntity.status(HttpStatus.NOT_FOUND).body(ApiResponse.error("없는 주소입니다."));
	}

	@ExceptionHandler(ApiException.class)
	public ResponseEntity<ApiResponse<Void>> handleApi(ApiException e) {
		return ResponseEntity.status(e.getStatus()).body(ApiResponse.error(e.getMessage()));
	}

	@ExceptionHandler(AiServerException.class)
	public ResponseEntity<ApiResponse<Void>> handleAiServer(AiServerException e) {
		log.error("AI 서버 호출 실패", e);
		return ResponseEntity.status(HttpStatus.BAD_GATEWAY).body(ApiResponse.error(e.getMessage()));
	}

	@ExceptionHandler(Exception.class)
	public ResponseEntity<ApiResponse<Void>> handleUnexpected(Exception e) {
		log.error("처리하지 못한 오류", e);
		return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
				.body(ApiResponse.error("서버 오류가 발생했습니다."));
	}
}
