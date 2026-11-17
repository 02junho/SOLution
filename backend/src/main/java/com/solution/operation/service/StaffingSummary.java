package com.solution.operation.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** 확인한 계획을 비교 구간에 맞게 요약한다. 대기·추천·통계를 계산하는 클래스가 아니다. */
final class StaffingSummary {

	private StaffingSummary() { }

	static Map<String, Object> from(Map<String, Object> plan, Map<String, Object> window, Map<String, Object> workerContext) {
		String startTime = String.valueOf(window.get("start_time"));
		String endTime = String.valueOf(window.get("end_time"));
		int start = minutes(startTime);
		int end = minutes(endTime);
		OperationResultContract.require(start < end);
		List<Map<String, Object>> assignments = new ArrayList<>();
		TreeMap<Integer, Integer> changes = new TreeMap<>();
		for (Map<String, Object> shift : OperationResultContract.maps(plan.get("schedule"))) {
			int clippedStart = Math.max(start, minutes(String.valueOf(shift.get("start_time"))));
			int clippedEnd = Math.min(end, minutes(String.valueOf(shift.get("end_time"))));
			if (clippedStart >= clippedEnd) {
				continue;
			}
			Map<String, Object> assignment = new LinkedHashMap<>();
            for (String key : List.of("worker_key", "task_code", "primary_role", "can_support"))
                if (shift.get(key) != null) assignment.put(key, shift.get(key));
            Object context = workerContext.get(shift.get("worker_key"));
            if (context instanceof Map<?, ?> person && person.get("is_owner") instanceof Boolean)
                assignment.put("is_owner", person.get("is_owner"));
            assignment.put("start_time", clock(clippedStart)); assignment.put("end_time", clock(clippedEnd));
            assignments.add(assignment);
			changes.merge(clippedStart, 1, Integer::sum);
			changes.merge(clippedEnd, -1, Integer::sum);
		}
		int current = 0;
		int maximum = 0;
		for (int change : changes.values()) {
			current += change;
			maximum = Math.max(maximum, current);
		}
		Map<String, Object> summary = new LinkedHashMap<>();
		summary.put("start_time", startTime);
		summary.put("end_time", endTime);
		summary.put("max_concurrent_workers", maximum);
		summary.put("assignments", assignments);
		int totalMinutes = OperationResultContract.maps(plan.get("schedule")).stream()
                .mapToInt(s -> minutes((String)s.get("end_time")) - minutes((String)s.get("start_time"))).sum();
        summary.put("total_staff_hours", totalMinutes / 60.0);
        summary.put("simulation_excludes_breaks", true);
		return summary;
	}

	private static int minutes(String time) {
		OperationResultContract.require(time.matches("(?:[01]\\d|2[0-3]):[0-5]\\d"));
		return Integer.parseInt(time.substring(0, 2)) * 60 + Integer.parseInt(time.substring(3));
	}

	private static String clock(int minutes) {
		return "%02d:%02d".formatted(minutes / 60, minutes % 60);
	}
}
