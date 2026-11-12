package com.solution.common.exception;

import org.springframework.http.HttpStatus;

/**
 * 요청을 처리할 수 없을 때 HTTP 상태와 사장님께 보여 줄 문구를 함께 던진다.
 * GlobalExceptionHandler가 { status: "error", message } 형식으로 바꾼다.
 *
 * <p>공통 응답에는 403·409를 두지 않는다 (가드레일 확인 사항 11.11). 다른 매장의 자료는 404, 옛 조건·확인 전은 400.
 */
public class ApiException extends RuntimeException {

	private final HttpStatus status;

	public ApiException(HttpStatus status, String message) {
		super(message);
		this.status = status;
	}

	public static ApiException notFound(String message) {
		return new ApiException(HttpStatus.NOT_FOUND, message);
	}

	public static ApiException badRequest(String message) {
		return new ApiException(HttpStatus.BAD_REQUEST, message);
	}

	public HttpStatus getStatus() {
		return status;
	}
}
