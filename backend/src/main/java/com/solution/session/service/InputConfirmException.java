package com.solution.session.service;

import org.springframework.http.HttpStatus;

/** 입력 확인 API의 명세상 오류 코드. 공통 오류 응답에는 영향을 주지 않는다. */
public class InputConfirmException extends RuntimeException {

	private final HttpStatus status;
	private final String detailCode;

	private InputConfirmException(HttpStatus status, String detailCode, String message) {
		super(message);
		this.status = status;
		this.detailCode = detailCode;
	}

	public static InputConfirmException notFound() {
		return new InputConfirmException(HttpStatus.NOT_FOUND, "VERSION_NOT_FOUND", "입력 버전을 찾을 수 없습니다.");
	}

	public static InputConfirmException stale() {
		return new InputConfirmException(HttpStatus.BAD_REQUEST, "STALE_VERSION",
				"조건이 바뀌었어요. 최신 입력을 다시 확인해 주세요.");
	}

	public HttpStatus getStatus() {
		return status;
	}

	public String getDetailCode() {
		return detailCode;
	}
}
