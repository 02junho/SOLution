package com.solution.operation.service;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import com.solution.common.client.AiServerException;

/** simulation 수치를 새로 계산하지 않고 공통 계약의 완결성만 검사한다. */
public final class OperationResultContract {

	public static final Set<String> CHOICES = Set.of("CURRENT", "ALT_A", "ALT_C");
	public static final List<String> METRICS = List.of("order_queue_wait_mean_seconds", "post_order_wait_mean_seconds",
			"total_time_mean_seconds", "total_time_p90_seconds", "post_order_wait_over_300_ratio",
			"completed_customer_count_mean", "throughput_per_hour_mean");

	private OperationResultContract() { }

	static void validateSimulation(Map<String, Object> data) {
		require(integer(data.get("requested_repetitions")) == 30 && integer(data.get("completed_repetitions")) == 30);
		require(data.get("metric_definitions") instanceof Map<?, ?> && !map(data.get("metric_definitions")).isEmpty());
		require(data.get("statistics_policy_version") instanceof String);
		require(data.get("comparison_window") instanceof Map<?, ?>);
		List<Map<String, Object>> plans = plans(data);
		for (Map<String, Object> plan : plans) {
			validateClosing(plan.get("closing"), integer(data.get("completed_repetitions")));
			Map<String, Object> metrics = map(plan.get("metrics"));
			for (String metric : METRICS) {
				double number = number(metrics.get(metric));
				require(number >= 0 && (!metric.endsWith("_ratio") || number <= 1));
			}
			if (!"CURRENT".equals(plan.get("choice_key"))) {
				Map<String, Object> comparison = map(plan.get("comparison"));
				require(METRICS.subList(0, 4).contains(comparison.get("metric")));
				number(comparison.get("delta_vs_current_seconds"));
				require(number(comparison.get("ci95_lower_seconds")) <= number(comparison.get("ci95_upper_seconds")));
				int paired = integer(comparison.get("paired_repetitions"));
				int better = integer(comparison.get("better_count"));
				require(paired == 30 && better >= 0 && better <= paired);
			}
		}
		require(data.containsKey("recommendation"));
		if (data.get("recommendation") != null) {
			Map<String, Object> recommendation = map(data.get("recommendation"));
			require(CHOICES.contains(recommendation.get("choice_key")));
			require(METRICS.subList(0, 5).contains(recommendation.get("basis_metric")));
			require(recommendation.get("reason") instanceof String text && !text.isBlank());
		}
		List<Map<String, Object>> repetitions = maps(data.get("replication_metrics"));
		require(repetitions.size() == 30);
		Set<Integer> seen = new HashSet<>();
		for (Map<String, Object> repetition : repetitions) {
			int number = integer(repetition.get("replication_no"));
			require(number >= 1 && number <= 30 && seen.add(number));
			for (Map<String, Object> plan : plans(repetition)) {
				Map<String, Object> metrics = map(plan.get("metrics"));
				for (String metric : METRICS) {
					double value = number(metrics.get(metric));
					require(value >= 0 && (!metric.endsWith("_ratio") || value <= 1));
				}
			}
		}
	}

	/** 마감 기준은 simulation 담당. 미제공을 성공으로 추정하지 않는다. */
    public static void validateClosing(Object value, int completed) {
        if (value == null) return;
        Map<String, Object> closing = map(value);
        int failed = integer(closing.get("failed_repetitions"));
        double ratio = number(closing.get("success_ratio"));
        require(completed > 0 && failed >= 0 && failed <= completed && ratio >= 0 && ratio <= 1);
        require(Math.abs(ratio - (completed - failed) / (double)completed) < 0.000001);
    }

	public static List<Map<String, Object>> plans(Map<String, Object> data) {
		require(java.util.stream.Stream.of("choices", "plans", "results").filter(data::containsKey).count() == 1);
		Object value = data.containsKey("choices") ? data.get("choices") : data.containsKey("plans") ? data.get("plans") : data.get("results");
		List<Map<String, Object>> rows = maps(value);
		require(rows.size() == 3 && rows.stream().map(row -> row.get("choice_key"))
				.collect(java.util.stream.Collectors.toSet()).equals(CHOICES));
		return rows;
	}

	/** 휴게는 simulation 미반영. 같은 직원·시간·역할을 두 계산이 쓰는지 확인할 계약이다. */
	public static List<Map<String, Object>> staffing(Object value) {
		List<Map<String, Object>> plans = maps(value);
		require(plans.size() == 3 && plans.stream().map(row -> row.get("choice_key"))
				.collect(java.util.stream.Collectors.toSet()).equals(CHOICES));
		List<Map<String, Object>> normalized = new ArrayList<>();
		for (Map<String, Object> plan : plans) {
			List<Map<String, Object>> shifts = new ArrayList<>();
			for (Map<String, Object> row : maps(plan.get("shifts"))) {
				Map<String, Object> shift = new LinkedHashMap<>();
				for (String key : List.of("worker_key", "start_time", "end_time", "task_code")) {
					require(row.get(key) instanceof String);
					shift.put(key, row.get(key));
				}
				if (row.get("primary_role") != null) {
					shift.put("primary_role", row.get("primary_role"));
					require(row.getOrDefault("can_support", List.of()) instanceof List<?>);
					shift.put("can_support", ((List<?>)row.getOrDefault("can_support", List.of())).stream().map(String.class::cast).sorted().toList());
				}
				shifts.add(shift);
			}
			require(!shifts.isEmpty());
			shifts.sort(Comparator.comparing(row -> row.get("worker_key") + ":" + row.get("start_time")));
			normalized.add(Map.of("choice_key", plan.get("choice_key"), "shifts", shifts));
		}
		normalized.sort(Comparator.comparing(row -> (String) row.get("choice_key")));
		return normalized;
	}

	public static double number(Object value) {
		require(value instanceof Number && Double.isFinite(((Number) value).doubleValue()));
		return ((Number) value).doubleValue();
	}

	public static int integer(Object value) {
		double n = number(value);
		require(n == Math.rint(n) && n >= Integer.MIN_VALUE && n <= Integer.MAX_VALUE);
		return (int) n;
	}

	@SuppressWarnings("unchecked")
	public static Map<String, Object> map(Object value) {
		require(value instanceof Map<?, ?>);
		return new LinkedHashMap<>((Map<String, Object>) value);
	}

	public static List<Map<String, Object>> maps(Object value) {
		require(value instanceof List<?>);
		List<Map<String, Object>> rows = new ArrayList<>();
		for (Object item : (List<?>) value) {
			rows.add(map(item));
		}
		return rows;
	}

	public static void require(boolean condition) {
		if (!condition) {
			throw new AiServerException("운영 계산 응답이 공통 계약을 충족하지 못했습니다. 시뮬레이션·인건비 연결 형식을 확인해 주세요.");
		}
	}
}
