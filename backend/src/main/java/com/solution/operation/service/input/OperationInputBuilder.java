package com.solution.operation.service.input;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.LinkedHashMap;

import com.solution.common.exception.ApiException;
import com.solution.operation.dto.input.OperationInputDraftRequest;

/**
 * 폼 값 → 운영 계산 입력. 저장 입력(work_version.input_json)은 폼 값만 담고({"operation_form": {...}}),
 * 계산할 때 OperationResultService가 {@link #expand}로 아래 모양을 만들어 쓴다.
 *
 * <pre>
 * { business_date, wage_year, assumptions_version,
 *   simulation: { scenario, repetitions, random_seed, execution_mode, selected_menu_ids? },
 *   labor: { timezone, rule_policy_version, auto_break, avoid_break_windows, workers, plans[CURRENT·ALT_A·ALT_C], cost_options } }
 * </pre>
 *
 * <p>세 안의 근무표 규칙 (시뮬레이션 엔진의 세 운영안과 같은 뜻):
 * <ul>
 *   <li>기본 2명(주문 담당 = 사장님 또는 직원 1, 제조 담당 = 직원)이 07~19시 모두 일한다.</li>
 *   <li>CURRENT: 주문 담당은 주문·전달, 제조 담당은 제조.</li>
 *   <li>ALT_A(서로 돕기): 바쁜 시간에만 서로의 일을 돕는다. 사람 수와 근무시간은 CURRENT와 같다.</li>
 *   <li>ALT_C(1명 추가): CURRENT에 바쁜 시간 동안 제조를 맡고 주문도 돕는 직원 1명을 더한다.</li>
 * </ul>
 * <p>바쁜 시간은 서로 돕기·한 명 추가가 바뀌는 구간(팀 결정 11.11)이고 휴게를 피하는 구간으로도 쓴다.
 * 사장님 입력으로 받지 않는다: 손님 몰림은 엔진이 상권 데이터로 정하므로, 바쁜 시간도 같은 데이터에서
 * 1시간당 주문이 가장 많은 시간대(PEAK_START~PEAK_END)를 쓴다. 시간대별로 인원을 정하는 일은 근무표 확장에서 한다.
 * 출퇴근 나누기는 하지 않는다(시간대별 인원 배치는 노동 쪽 배치표 생성 기능의 일).
 *
 * <p>대화 입력도 폼 값만 저장하므로 빌더는 이것 하나다.
 *
 * <p>숫자(대기·비용)는 계산하지 않는다. 계산은 simulation·labor 도구가 한다.
 */
public final class OperationInputBuilder {

	public static final String ASSUMPTIONS_VERSION = "operation.v1";
	public static final String DAY_START = "07:00";
	public static final String DAY_END = "19:00";
	static final String DEFAULT_LAST_ORDER = "18:45";
	static final String CODE = "INVALID_REQUEST";
	/** 30회 반복 계산이 Spring 응답 대기(120초) 안에 끝나는 하루 주문 상한. 엔진 /compare 한도와 같다. */
	static final int MAX_DAILY_ORDERS = 300;
	/** 저장 입력에서 폼 값을 담는 칸. 대화(ai-server operation_fields.DRAFT_KEY)·화면과 같은 이름이다. */
	public static final String FORM_KEY = "operation_form";
	/**
	 * 바쁜 시간: 상권 데이터(ai-server app/tools/simulation/data/demand_shares.json)에서 1시간당 주문이 가장 많은 시간대.
	 * 서로 돕기·한 명 추가가 바뀌고 휴게를 피하는 구간이다. 데이터와 같은지 테스트로 맞춘다.
	 */
	public static final String PEAK_START = "11:00";
	public static final String PEAK_END = "14:00";
	/** 해마다 고시되는 최저시급(labor 정책 policies.MINIMUM_WAGES와 같은 값). 없는 해는 계산하지 않는다. */
	static final Map<Integer, Integer> MINIMUM_WAGES = Map.of(2026, 10_320, 2027, 10_700);
	/** 고를 수 있는 메뉴(시뮬레이션 엔진 ai-server app/tools/simulation/menu_catalog.json의 menu_id와 같다. 테스트로 맞춘다). */
	static final Set<String> MENU_IDS = Set.of("iced_americano", "iced_green_tea_latte", "iced_cafe_latte",
			"hot_cafe_latte", "blueberry_yogurt_smoothie", "hot_americano", "iced_vanilla_latte", "iced_milk_tea",
			"iced_lemon_ade", "iced_choco_latte");
	private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");

	private OperationInputBuilder() { }

	/** 근무 한 구간. */
	record Shift(String workerKey, String start, String end, String taskCode) {
		Map<String, Object> asMap() {
			Map<String, Object> row = new LinkedHashMap<>();
			row.put("worker_key", workerKey);
			row.put("start_time", start);
			row.put("end_time", end);
			row.put("task_code", taskCode);
			row.put("breaks", List.of());
			return row;
		}
	}

	public static Map<String, Object> build(OperationInputDraftRequest form) {
		return build(form, LocalDate.now(SEOUL));
	}

	/**
	 * 저장 입력 → 운영 계산 입력. 폼 값({"operation_form": {...}})이면 근무표 세 안까지 만든다.
	 * 필수 값(하루 주문·사장님 근무·시급)이 아직 없거나 예전 완성본(simulation·labor가 이미 있음)이면 그대로 돌려준다
	 * (빠진 값은 OperationResultService가 입력 필요로 알린다).
	 */
	public static Map<String, Object> expand(Map<String, Object> stored) {
		return expand(stored, LocalDate.now(SEOUL));
	}

	public static Map<String, Object> expand(Map<String, Object> stored, LocalDate today) {
		if (stored == null || !(stored.get(FORM_KEY) instanceof Map<?, ?> raw)) {
			return stored;
		}
		OperationInputDraftRequest form = fromForm(raw);
		if (form.dailyOrders() == null || form.isOwnerWorking() == null || form.hourlyWageKrw() == null) {
			return stored;
		}
		return build(form, today);
	}

	/** 저장된 폼 값(snake_case) → 폼 요청. 모양이 틀리면 400. */
	static OperationInputDraftRequest fromForm(Map<?, ?> form) {
		try {
			Object date = form.get("business_date");
			Map<String, Double> weights = null;
			if (form.get("menu_weights") instanceof Map<?, ?> raw) {
				weights = new LinkedHashMap<>();
				for (var e : raw.entrySet()) {
					weights.put((String) e.getKey(), e.getValue() == null ? null : ((Number) e.getValue()).doubleValue());
				}
			}
			List<String> menus = null;
			if (form.get("selected_menu_ids") instanceof List<?> raw) {
				menus = raw.stream().map(id -> (String) id).toList();
			}
			return new OperationInputDraftRequest(date == null ? null : LocalDate.parse((String) date),
					integer(form.get("daily_orders")), (String) form.get("last_order_time"), menus,
					(Boolean) form.get("is_owner_working"), integer(form.get("hourly_wage_krw")),
					(Boolean) form.get("is_staff_minor"), weights,
					integer(form.get("order_time_sec")), integer(form.get("handoff_time_sec")));
		}
		catch (ClassCastException | java.time.format.DateTimeParseException e) {
			throw ApiException.badRequest(CODE, "저장된 운영 조건을 읽지 못했어요. 조건을 다시 저장해 주세요.");
		}
	}

	/** 정수만 받는다(150.0은 되고 150.5는 안 됨). */
	private static Integer integer(Object value) {
		if (value == null) {
			return null;
		}
		double number = ((Number) value).doubleValue();
		if (number != Math.rint(number) || Math.abs(number) > Integer.MAX_VALUE) {
			throw ApiException.badRequest(CODE, "저장된 운영 조건의 숫자를 확인해 주세요.");
		}
		return (int) number;
	}

	public static Map<String, Object> build(OperationInputDraftRequest form, LocalDate today) {
		if (form == null || form.dailyOrders() == null || form.isOwnerWorking() == null || form.hourlyWageKrw() == null) {
			throw ApiException.badRequest(CODE, "하루 주문 수, 사장님 근무 여부, 직원 시급을 입력해 주세요.");
		}
		if (form.dailyOrders() < 1 || form.dailyOrders() > MAX_DAILY_ORDERS) {
			throw ApiException.badRequest(CODE, "하루 주문 수는 1~300건으로 입력해 주세요.");
		}
		LocalDate date = form.businessDate() != null ? form.businessDate() : today;
		Integer minimum = MINIMUM_WAGES.get(date.getYear());
		if (minimum == null) {
			throw ApiException.badRequest(CODE, date.getYear() + "년 최저시급 기준이 아직 없어요. 영업일을 확인해 주세요.");
		}
		if (form.hourlyWageKrw() < minimum) {
			throw ApiException.badRequest(CODE,
					String.format(Locale.KOREA, "직원 시급은 %d년 최저시급(%,d원) 이상으로 입력해 주세요.", date.getYear(), minimum));
		}
		String lastOrder = time(form.lastOrderTime(), DEFAULT_LAST_ORDER, "라스트 오더");
		if (lastOrder.compareTo("18:30") < 0 || lastOrder.compareTo(DAY_END) > 0) {
			throw ApiException.badRequest(CODE, "라스트 오더는 18:30~19:00 사이로 골라 주세요.");
		}
		String rushStart = PEAK_START;
		String rushEnd = PEAK_END;
		boolean owner = form.isOwnerWorking();
		boolean minor = Boolean.TRUE.equals(form.isStaffMinor());
		if (minor) {
			// 근무표가 07-19시로 고정이라 연소자 하루 7시간 한도를 넘는다. 계산 단계(노동)에서 막히기 전에 여기서 알린다.
			throw ApiException.badRequest(CODE, "연소자 직원은 하루 7시간까지만 일할 수 있어, 07-19시 근무로 비교하는 이번 운영 실험에서는 계산할 수 없어요.");
		}
		String lead = owner ? "OWNER" : "STAFF_1";
		String maker = owner ? "STAFF_1" : "STAFF_2";
		String extra = owner ? "STAFF_2" : "STAFF_3";

		List<Map<String, Object>> workers = new ArrayList<>();
		workers.add(worker(lead, owner, owner ? null : minor, owner ? null : form.hourlyWageKrw()));
		workers.add(worker(maker, false, minor, form.hourlyWageKrw()));
		workers.add(worker(extra, false, minor, form.hourlyWageKrw()));

		List<Map<String, Object>> plans = new ArrayList<>();
		plans.add(plan("CURRENT", List.of(new Shift(lead, DAY_START, DAY_END, "ORDER_HANDOFF"),
				new Shift(maker, DAY_START, DAY_END, "PREPARATION"))));
		List<Shift> altA = new ArrayList<>(helpInRush(lead, "ORDER_HANDOFF", "ORDER_HANDOFF_HELP_PREPARATION", rushStart, rushEnd));
		altA.addAll(helpInRush(maker, "PREPARATION", "PREPARATION_HELP_ORDER_HANDOFF", rushStart, rushEnd));
		plans.add(plan("ALT_A", altA));
		plans.add(plan("ALT_C", List.of(new Shift(lead, DAY_START, DAY_END, "ORDER_HANDOFF"),
				new Shift(maker, DAY_START, DAY_END, "PREPARATION"),
				new Shift(extra, rushStart, rushEnd, "PREPARATION_HELP_ORDER_HANDOFF"))));

		Map<String, Object> scenario = new LinkedHashMap<>();
		scenario.put("daily_orders", form.dailyOrders());
		scenario.put("last_order_time", lastOrder);
		scenario.put("share_method", "p50");
		scenario.put("takeout_ratio", 0.4);
		Map<String, Object> simulation = new LinkedHashMap<>();
		simulation.put("scenario", scenario);
		simulation.put("repetitions", 30);
		simulation.put("random_seed", 42);
		simulation.put("execution_mode", "continuous_day");
		// 안마다 1번째 반복의 손님·직원 움직임을 재생 기록(execution_log, simulation_trace)으로 남긴다. 화면 대기열 재생용.
		simulation.put("include_events", true);
		if (form.selectedMenuIds() != null && !form.selectedMenuIds().isEmpty()) {
			if (form.selectedMenuIds().stream().anyMatch(id -> id == null || !MENU_IDS.contains(id))) {
				throw ApiException.badRequest(CODE, "메뉴 선택을 다시 확인해 주세요.");
			}
			if (form.menuWeights() == null || form.menuWeights().isEmpty()) {
				// 기본 비중이 0인 메뉴도 있어서, 메뉴를 고르면 비중도 같이 받아야 계산할 수 있다.
				throw ApiException.badRequest(CODE, "메뉴를 고르면 판매 비중도 함께 넣어 주세요.");
			}
			simulation.put("selected_menu_ids", List.copyOf(new TreeSet<>(form.selectedMenuIds())));
		}
		if (form.menuWeights() != null && !form.menuWeights().isEmpty()) {
			simulation.put("menu_weights", weights(form.menuWeights(), form.selectedMenuIds()));
		}
		if (form.orderTimeSec() != null) {
			simulation.put("order_time_sec", range(form.orderTimeSec(), "주문·결제 시간"));
		}
		if (form.handoffTimeSec() != null) {
			simulation.put("handoff_time_sec", range(form.handoffTimeSec(), "음료 전달 시간"));
		}

		Map<String, Object> labor = new LinkedHashMap<>();
		labor.put("timezone", "Asia/Seoul");
		labor.put("rule_policy_version", "labor.kr." + date.getYear() + ".v1");
		labor.put("auto_break", true);
		labor.put("avoid_break_windows", List.of(Map.of("start_time", rushStart, "end_time", rushEnd)));
		labor.put("workers", workers);
		labor.put("plans", plans);
		labor.put("cost_options", Map.of("include_weekly_holiday", false, "include_employer_insurance", false));

		Map<String, Object> input = new LinkedHashMap<>();
		input.put("business_date", date.toString());
		input.put("wage_year", date.getYear());
		input.put("assumptions_version", ASSUMPTIONS_VERSION);
		input.put("simulation", simulation);
		input.put("labor", labor);
		return input;
	}

	/** 07~19시 근무를 바쁜 시간 앞·바쁜 시간(서로 돕기)·뒤로 나눈다. 사람과 근무시간은 그대로다. 길이 0인 구간은 뺀다. */
	static List<Shift> helpInRush(String worker, String task, String helpTask, String rushStart, String rushEnd) {
		List<Shift> shifts = new ArrayList<>();
		if (DAY_START.compareTo(rushStart) < 0) {
			shifts.add(new Shift(worker, DAY_START, rushStart, task));
		}
		shifts.add(new Shift(worker, rushStart, rushEnd, helpTask));
		if (rushEnd.compareTo(DAY_END) < 0) {
			shifts.add(new Shift(worker, rushEnd, DAY_END, task));
		}
		return shifts;
	}

	private static Map<String, Object> plan(String choice, List<Shift> shifts) {
		List<Map<String, Object>> rows = new ArrayList<>();
		shifts.forEach(s -> rows.add(s.asMap()));
		Map<String, Object> plan = new LinkedHashMap<>();
		plan.put("choice_key", choice);
		plan.put("shifts", rows);
		return plan;
	}

	private static Map<String, Object> worker(String key, boolean owner, Boolean minor, Integer wage) {
		Map<String, Object> worker = new LinkedHashMap<>();
		worker.put("worker_key", key);
		worker.put("is_owner", owner);
		worker.put("is_minor", minor);
		worker.put("hourly_wage_krw", wage);
		return worker;
	}

	/** 판매 비중: 고른 메뉴와 같은 메뉴만, 0~1, 합계 1(반올림 오차 0.001까지). 메뉴 이름 순으로 넣는다. */
	private static Map<String, Object> weights(Map<String, Double> weights, List<String> selected) {
		if (selected == null || !new TreeSet<>(selected).equals(new TreeSet<>(weights.keySet()))) {
			throw ApiException.badRequest(CODE, "판매 비중은 고른 메뉴마다 하나씩 넣어 주세요.");
		}
		double sum = 0;
		Map<String, Object> out = new LinkedHashMap<>();
		for (String id : new TreeSet<>(weights.keySet())) {
			Double value = weights.get(id);
			if (value == null || value.isNaN() || value < 0 || value > 1) {
				throw ApiException.badRequest(CODE, "판매 비중은 0~100% 사이여야 해요.");
			}
			sum += value;
			out.put(id, value);
		}
		if (Math.abs(sum - 1) > 0.001) {
			throw ApiException.badRequest(CODE, "판매 비중 합계가 100%가 되게 맞춰 주세요.");
		}
		return out;
	}

	private static int range(int seconds, String label) {
		if (seconds < 1 || seconds > 300) {
			throw ApiException.badRequest(CODE, label + "은 1~300초로 입력해 주세요.");
		}
		return seconds;
	}

	private static String time(String value, String fallback, String label) {
		String text = value == null || value.isBlank() ? fallback : value.trim();
		if (!text.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) {
			throw ApiException.badRequest(CODE, label + " 시각은 HH:mm 형식이어야 해요.");
		}
		if (text.compareTo(DAY_START) < 0 || text.compareTo(DAY_END) > 0) {
			throw ApiException.badRequest(CODE, label + " 시각은 07:00~19:00 안에서 골라 주세요.");
		}
		return text;
	}
}
