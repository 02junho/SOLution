package com.solution.session.service;

import org.springframework.http.HttpStatus;

import com.solution.common.exception.ApiException;

/** 다른 매장과 존재하지 않는 업무를 동일한 오류로 숨긴다. */
public class MessageHistoryException extends ApiException {

	public MessageHistoryException() {
		super(HttpStatus.NOT_FOUND, "업무를 찾을 수 없습니다.");
	}
}
