package com.solution.operation.dto;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 직원별 전체 배치. simulation 체류시간과 급여의 유급시간을 구분한다. */
public record StaffingPlan(String choiceKey, List<Shift> shifts) {
	public StaffingPlan { shifts = List.copyOf(shifts); }

	public record Shift(String workerKey, String startTime, String endTime, String taskCode,
			String primaryRole, List<String> canSupport) {
		public Shift { canSupport = canSupport == null ? List.of() : List.copyOf(canSupport); }
		/** 기존 검토용 입력은 의미를 바꾸지 않고 명시적으로 유지한다. */
		public Shift(String workerKey, String startTime, String endTime, String taskCode) {
			this(workerKey, startTime, endTime, taskCode, null, List.of());
		}
		public Map<String, Object> asMap() {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("worker_key", workerKey); row.put("start_time", startTime);
			row.put("end_time", endTime); row.put("task_code", taskCode);
			if (primaryRole != null) { row.put("primary_role", primaryRole); row.put("can_support", canSupport); }
			return row;
		}
	}

	public Map<String, Object> asMap() {
		return Map.of("choice_key", choiceKey, "shifts", shifts.stream().map(Shift::asMap).toList());
	}

	@SuppressWarnings("unchecked")
	public static StaffingPlan fromConfirmedPlan(Map<String, Object> plan) {
		List<Map<String, Object>> rows = (List<Map<String, Object>>) plan.get("shifts");
		List<Shift> result = new ArrayList<>();
		for (Map<String, Object> row : rows) {
			result.add(new Shift((String) row.get("worker_key"), (String) row.get("start_time"),
					(String) row.get("end_time"), (String) row.get("task_code"), (String) row.get("primary_role"),
					(List<String>) row.getOrDefault("can_support", List.of())));
		}
		return new StaffingPlan((String) plan.get("choice_key"), result);
	}
}
