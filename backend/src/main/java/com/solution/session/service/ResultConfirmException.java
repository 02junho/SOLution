package com.solution.session.service;

import org.springframework.http.HttpStatus;

import com.solution.common.exception.ApiException;

public class ResultConfirmException extends ApiException {

	private final String detailCode;

	public ResultConfirmException(String detailCode, String message) {
		this(HttpStatus.BAD_REQUEST, detailCode, message);
	}

	private ResultConfirmException(HttpStatus status, String detailCode, String message) {
		super(status, message);
		this.detailCode = detailCode;
	}

	public static ResultConfirmException notFound() {
		return new ResultConfirmException(HttpStatus.NOT_FOUND, "RESULT_NOT_FOUND", "결과를 찾을 수 없습니다.");
	}

	public String getDetailCode() {
		return detailCode;
	}
}
