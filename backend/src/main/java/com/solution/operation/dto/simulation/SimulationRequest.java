package com.solution.operation.dto.simulation;

import com.solution.operation.dto.StaffingPlan;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 확인된 내부 입력. 실제 simulation 요청·응답 계약은 가영 담당 구현과 함께 검토한다. */
public record SimulationRequest(long sessionId, long inputVersionId, long resultId,
		Map<String, Object> conditions, List<StaffingPlan> expectedStaffing) {

	public SimulationRequest {
		conditions = Collections.unmodifiableMap(new LinkedHashMap<>(conditions));
		expectedStaffing = List.copyOf(expectedStaffing);
	}
}
