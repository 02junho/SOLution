package com.solution.operation.dto.labor;

import java.util.Map;

/** 단계별 도구 결과를 보존하는 성공 DTO. 대기·추천·통계를 재계산하지 않는다. */
public record LaborResult(Map<String, Object> schedule, Map<String, Object> cost) {
	public Map<String, Object> asMap() { return Map.of("schedule", schedule, "cost", cost); }
}
