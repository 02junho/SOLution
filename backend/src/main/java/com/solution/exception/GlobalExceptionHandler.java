package com.solution.exception;

import com.solution.common.response.ApiResponse;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.web.server.ResponseStatusException;

public class GlobalExceptionHandler {
    // GlobalExceptionHandler 클래스 내부
    @ExceptionHandler(ResponseStatusException.class)
    public ResponseEntity<ApiResponse<Void>> handleResponseStatusException(
            ResponseStatusException e) {

        String message = e.getReason() != null
                ? e.getReason()
                : "요청을 처리하지 못했습니다.";

        return ResponseEntity.status(e.getStatusCode())
                .body(ApiResponse.error(message));
    }
}
