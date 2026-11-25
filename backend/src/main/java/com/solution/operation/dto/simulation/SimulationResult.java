package com.solution.operation.dto.simulation;

import com.solution.operation.dto.StaffingPlan;

import java.util.List;
import java.util.Map;

import com.solution.common.response.ApiResponse;

/**
 * 내부 반환 DTO 초안. response는 기존 공통 응답·확정된 metrics/comparison/recommendation을 보존한다.
 * staffing에는 시뮬레이션에 실제 사용한 전체 인력 계획을 4번이 채운다. 미확인이면 null.
 * closing의 JSON 이름·판정 기준은 합의 전이라 새 필수 필드나 성공 기본값을 만들지 않는다.
 */
public record SimulationResult(ApiResponse<Map<String, Object>> response,
		List<StaffingPlan> staffing, String requestKey) {
}
