package com.solution.explain;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 저장된 계산 결과(work_result.summary_json) → /agent/explain에 넘길 작은 요약. 작성: 신준호
 *
 * <p>API 명세(「POST /agent/explain (FastAPI)」): 전체 결과를 LLM에 넘기지 않고 Spring이 필요한 칸만 추린다.
 * 설명은 넘긴 숫자만 쓸 수 있으므로(H07), 사장님께 보여 줄 숫자만 고른다. 계산·판단은 하지 않는다.
 */
final class ExplanationSummary {

	private ExplanationSummary() {
	}

	/**
	 * /agent/explain은 숫자를 글로 쓴 말("한 명")과 "주문"이라는 단어를 막는다(발주 권유·지어낸 숫자 방지).
	 * 그래서 운영 요약은 안 이름을 "직원 추가"로, 대기 지표를 "음료를 받기까지 기다린 시간"(drink_wait)으로 넘기고,
	 * 설명에 쓰일 5분 기준도 숫자로 넣어 둔다. 화면의 안 이름(한 명 추가)은 화면이 따로 붙인다.
	 */
	static final Map<String, String> OPERATION_LABELS = Map.of(
			"CURRENT", "현재 방식", "ALT_A", "서로 돕기", "ALT_C", "직원 추가");
	static final int WAIT_THRESHOLD_MINUTES = 5;

	static Map<String, Object> purchase(Map<String, Object> stored) {
		List<Map<String, Object>> choices = new ArrayList<>();
		for (Map<String, Object> choice : maps(stored.get("choices"))) {
			if (Boolean.FALSE.equals(choice.get("available"))) {
				continue;
			}
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("choice_key", choice.get("choice_key"));
			row.put("label", choice.get("label"));
			row.put("total_krw", choice.get("total_krw"));
			row.put("delivery_count", choice.get("delivery_count"));
			row.put("warning_ids", choice.getOrDefault("warning_ids", List.of()));
			List<String> suppliers = new ArrayList<>();
			for (Map<String, Object> supplier : maps(choice.get("supplier_totals"))) {
				if (supplier.get("supplier_name") instanceof String name) {
					suppliers.add(name);
				}
			}
			row.put("suppliers", suppliers);
			choices.add(row);
		}
		Map<String, Object> summary = new LinkedHashMap<>();
		summary.put("choices", choices);
		if (stored.get("baseline") instanceof Map<?, ?> baseline) {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("label", baseline.get("label"));
			row.put("total_krw", baseline.get("total_krw"));
			row.put("confirmable", baseline.get("confirmable"));
			summary.put("baseline", row);
		}
		summary.put("warnings", warnings(stored.get("warnings")));
		summary.put("assumptions", strings(stored.get("assumptions")));
		return summary;
	}

	/**
	 * 운영: 안마다 하루 인건비(원)와 대기 지표. 비율은 설명이 퍼센트로 쓸 수 있게 *_pct(소수 첫째 자리)로 넘긴다.
	 * 추천 안은 recommended_choice_key로 넘기고, 추천 판단은 저장된 결과 그대로다.
	 */
	@SuppressWarnings("unchecked")
	static Map<String, Object> operation(Map<String, Object> stored) {
		List<Map<String, Object>> choices = new ArrayList<>();
		for (Map<String, Object> choice : maps(stored.get("choices"))) {
			String key = String.valueOf(choice.get("choice_key"));
			Map<String, Object> metrics = choice.get("metrics") instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("choice_key", key);
			row.put("label", OPERATION_LABELS.getOrDefault(key, key));
			row.put("total_krw", whole(choice.get("cash_cost_krw")));
			row.put("drink_wait_mean_minutes", minutes(metrics.get("post_order_wait_mean_seconds")));
			row.put("drink_wait_over_5min_pct", percent(metrics.get("post_order_wait_over_300_ratio")));
			row.put("wait_threshold_minutes", WAIT_THRESHOLD_MINUTES);
			if (choice.get("staffing_summary") instanceof Map<?, ?> staffing) {
				row.put("total_staff_hours", staffing.get("total_staff_hours"));
			}
			choices.add(row);
		}
		Map<String, Object> summary = new LinkedHashMap<>();
		summary.put("choices", choices);
		Object recommendation = stored.get("recommendation");
		summary.put("recommended_choice_key",
				recommendation instanceof Map<?, ?> r ? r.get("choice_key") : null);
		summary.put("meaning",
				"total_krw는 하루 인건비(원), drink_wait는 손님이 계산을 마치고 음료를 받기까지 기다린 시간(분)");
		summary.put("warnings", warnings(stored.get("warnings")));
		summary.put("assumptions", strings(stored.get("assumptions")));
		return summary;
	}

	private static List<Map<String, Object>> warnings(Object value) {
		List<Map<String, Object>> rows = new ArrayList<>();
		for (Map<String, Object> warning : maps(value)) {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("warning_id", warning.get("warning_id"));
			row.put("message", warning.get("message"));
			row.put("requires_ack", Boolean.TRUE.equals(warning.get("requires_ack")));
			rows.add(row);
		}
		return rows;
	}

	@SuppressWarnings("unchecked")
	private static List<Map<String, Object>> maps(Object value) {
		List<Map<String, Object>> rows = new ArrayList<>();
		if (value instanceof List<?> list) {
			for (Object item : list) {
				if (item instanceof Map<?, ?> map) {
					rows.add((Map<String, Object>) map);
				}
			}
		}
		return rows;
	}

	private static List<String> strings(Object value) {
		List<String> rows = new ArrayList<>();
		if (value instanceof List<?> list) {
			for (Object item : list) {
				if (item instanceof String text) {
					rows.add(text);
				}
			}
		}
		return rows;
	}

	private static Long whole(Object value) {
		return value instanceof Number number
				? new BigDecimal(number.toString()).setScale(0, RoundingMode.HALF_UP).longValueExact() : null;
	}

	private static BigDecimal minutes(Object seconds) {
		return seconds instanceof Number number
				? new BigDecimal(number.toString()).divide(BigDecimal.valueOf(60), 1, RoundingMode.HALF_UP) : null;
	}

	private static BigDecimal percent(Object ratio) {
		return ratio instanceof Number number
				? new BigDecimal(number.toString()).multiply(BigDecimal.valueOf(100)).setScale(1, RoundingMode.HALF_UP)
				: null;
	}
}
