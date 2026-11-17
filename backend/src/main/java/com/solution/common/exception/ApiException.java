package com.solution.common.exception;

import org.springframework.http.HttpStatus;

/**
 * 요청을 처리할 수 없을 때 HTTP 상태와 사장님께 보여 줄 문구를 함께 던진다.
 * GlobalExceptionHandler가 { status: "error", data, message } 형식으로 바꾼다.
 *
 * <p>공통 응답에는 403·409를 두지 않는다 (가드레일 확인 사항 11.11). 다른 매장의 자료는 404, 옛 조건·확인 전은 400.
 *
 * <p>detail_code(사유 코드)를 주면 data에 { "detail_code": ... }로 나간다. 화면이 문구가 아니라 코드로 사유를 나눌 수 있다
 * (상태코드·경고 점검 공유사항 11.17). 주지 않으면 data는 null로 지금과 같다.
 */
public class ApiException extends RuntimeException {

	private final HttpStatus status;
	private final String detailCode;

	public ApiException(HttpStatus status, String message) {
		this(status, null, message);
	}

	public ApiException(HttpStatus status, String detailCode, String message) {
		super(message);
		this.status = status;
		this.detailCode = detailCode;
	}

	public static ApiException notFound(String message) {
		return new ApiException(HttpStatus.NOT_FOUND, message);
	}

	public static ApiException notFound(String detailCode, String message) {
		return new ApiException(HttpStatus.NOT_FOUND, detailCode, message);
	}

	public static ApiException badRequest(String message) {
		return new ApiException(HttpStatus.BAD_REQUEST, message);
	}

	public static ApiException badRequest(String detailCode, String message) {
		return new ApiException(HttpStatus.BAD_REQUEST, detailCode, message);
	}

	public HttpStatus getStatus() {
		return status;
	}

	/** 사유 코드. 없으면 null. */
	public String getDetailCode() {
		return detailCode;
	}
}
