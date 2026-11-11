package com.solution.common.response;

import com.fasterxml.jackson.annotation.JsonCreator;
import com.fasterxml.jackson.annotation.JsonValue;

/**
 * 모든 API 공통 응답 상태. 기능별 세부 상태(최적해 여부 등)는 늘리지 않고 응답 data 안에 넣는다.
 */
public enum ResponseStatus {
	OK("ok"),
	NEEDS_INPUT("needs_input"),
	INFEASIBLE("infeasible"),
	ERROR("error");

	private final String value;

	ResponseStatus(String value) {
		this.value = value;
	}

	@JsonValue
	public String getValue() {
		return value;
	}

	@JsonCreator
	public static ResponseStatus from(String value) {
		for (ResponseStatus status : values()) {
			if (status.value.equals(value)) {
				return status;
			}
		}
		throw new IllegalArgumentException("알 수 없는 응답 상태: " + value);
	}
}
