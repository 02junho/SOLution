package com.solution.operation.dto.labor;

import java.util.Map;

/** 확인된 work_version의 비용 조건. 직원 소유자 여부·시급은 simulation의 역할에서 추정하지 않는다. */
public record LaborRequest(Map<String, Object> confirmedInput, long sessionId, long inputVersionId) {
	public LaborRequest { confirmedInput = java.util.Collections.unmodifiableMap(new java.util.LinkedHashMap<>(confirmedInput)); }
}
