package com.solution.session.service;

import org.springframework.http.HttpStatus;

import com.solution.common.exception.ApiException;

public class ConfirmationNotFoundException extends ApiException {

	public ConfirmationNotFoundException() {
		super(HttpStatus.NOT_FOUND, "확정 기록을 찾을 수 없습니다.");
	}
}
