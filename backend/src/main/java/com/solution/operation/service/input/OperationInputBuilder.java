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
 *   <li>기본 2명(주문 담당 = 사장님 또는 직원 1, 제조 담당 = 직원)이 오픈~마감(기본 07~19시) 모두 일한다.</li>
 *   <li>CURRENT: 주문 담당은 주문·전달, 제조 담당은 제조.</li>
 *   <li>ALT_A(서로 돕기): 바쁜 시간에만 서로의 일을 돕는다. 사람 수와 근무시간은 CURRENT와 같다.</li>
 *   <li>ALT_C(1명 추가): CURRENT에 바쁜 시간 동안 제조를 맡고 주문도 돕는 직원 1명을 더한다.</li>
 * </ul>
 * <p>바쁜 시간은 서로 돕기·한 명 추가가 바뀌는 구간(팀 결정 11.11)이고 휴게를 피하는 구간으로도 쓴다.
 * 사장님 입력으로 받지 않는다: 손님 몰림은 엔진이 상권 데이터로 정하므로, 바쁜 시간도 같은 데이터에서
 * 1시간당 주문이 가장 많은 시간대(PEAK_START~PEAK_END)를 쓴다. 시간대별로 인원을 정하는 일은 근무표 확장에서 한다.
 * 출퇴근 나누기는 하지 않는다(시간대별 인원 배치는 노동 쪽 배치표 생성 기능의 일).
 *
 * <p>가게 데이터 버전: 영업시간(open_time·close_time), 메뉴별 잔 수(menu_cups), 메뉴별 제조시간(manufacture_sec_by_menu),
 * 시간대별 주문 수(orders_by_slot, 예: 1시간 단위), 바쁜 시간(peak_start_time·peak_end_time)을 받으면 근무표와 엔진 입력을
 * 그 값으로 만든다. 시간대별 주문이 있으면 영업시간과 하루 주문 수는 거기서 정하고, 잔 수는 판매 비중에만 쓴다.
 * 안 넣으면 지금 버전과 같은 입력이다(기본값이면 결과가 같다). 파일 근거(store_source)는 폼에만 남고 계산에는 안 쓴다.
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
	/** 영업시간 범위(ai-server day_window와 같다). 상권 데이터 시간대(06~11·17~21시)가 있는 범위다. */
	static final String OPEN_MIN = "06:00";
	static final String OPEN_MAX = "10:30";
	static final String CLOSE_MIN = "17:30";
	static final String CLOSE_MAX = "21:00";
	/** 가게 시간대별 주문이 있을 때 영업시간 범위(ai-server day_window와 같다). */
	static final String STORE_OPEN_MIN = "05:00";
	static final String STORE_CLOSE_MAX = "23:30";
	static final int STORE_MIN_HOURS = 4;
	/** 목표 대기 범위(초)와 기계 대수 범위. */
	static final int MIN_TARGET_WAIT_SEC = 120;
	static final int MAX_TARGET_WAIT_SEC = 600;
	static final int MAX_MACHINES = 3;
	/** 메뉴별 제조시간 범위(초). */
	static final int MIN_MANUFACTURE_SEC = 10;
	static final int MAX_MANUFACTURE_SEC = 600;
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
		if (!hasOrders(form) || form.isOwnerWorking() == null || form.hourlyWageKrw() == null) {
			return stored;
		}
		return build(form, today);
	}

	/**
	 * 저장된 폼에서 계산에 꼭 필요한 값 중 빠진 것(path는 operation_form.필드명).
	 * 폼 모양이 아니면(예전 완성본) 빈 목록이다. {@link #expand}가 그대로 돌려주는 조건과 같다.
	 */
	public static List<Map<String, Object>> missingFormFields(Map<String, Object> stored) {
		if (stored == null || !(stored.get(FORM_KEY) instanceof Map<?, ?> form)) {
			return List.of();
		}
		List<Map<String, Object>> missing = new ArrayList<>();
		for (String[] field : new String[][] {{"daily_orders", "하루 주문 수", "건"},
				{"is_owner_working", "사장님 근무 여부", null}, {"hourly_wage_krw", "직원 시급", "원"}}) {
			boolean ordersFromStore = form.get("menu_cups") instanceof Map<?, ?> || form.get("orders_by_slot") instanceof Map<?, ?>;
			if (form.get(field[0]) == null && !("daily_orders".equals(field[0]) && ordersFromStore)) {
				Map<String, Object> row = new LinkedHashMap<>();
				row.put("path", FORM_KEY + "." + field[0]);
				row.put("label", field[1]);
				row.put("unit", field[2]);
				missing.add(row);
			}
		}
		return missing;
	}

	/** 저장된 폼 값(snake_case) → 폼 요청. 없거나 null인 칸은 생략으로 보고, 값이 있는데 모양이 틀리면 400. */
	static OperationInputDraftRequest fromForm(Map<?, ?> form) {
		try {
			Object date = form.get("business_date");
			Map<String, Double> weights = null;
			Object rawWeights = form.get("menu_weights");
			if (rawWeights != null) {
				if (!(rawWeights instanceof Map<?, ?> raw)) {
					throw new ClassCastException("menu_weights");
				}
				weights = new LinkedHashMap<>();
				for (var e : raw.entrySet()) {
					weights.put((String) e.getKey(), e.getValue() == null ? null : ((Number) e.getValue()).doubleValue());
				}
			}
			List<String> menus = null;
			Object rawMenus = form.get("selected_menu_ids");
			if (rawMenus != null) {
				if (!(rawMenus instanceof List<?> raw)) {
					throw new ClassCastException("selected_menu_ids");
				}
				menus = raw.stream().map(id -> (String) id).toList();
			}
			return new OperationInputDraftRequest(date == null ? null : LocalDate.parse((String) date),
					integer(form.get("daily_orders")), (String) form.get("last_order_time"), menus,
					(Boolean) form.get("is_owner_working"), integer(form.get("hourly_wage_krw")),
					(Boolean) form.get("is_staff_minor"), weights,
					integer(form.get("order_time_sec")), integer(form.get("handoff_time_sec")),
					(String) form.get("open_time"), (String) form.get("close_time"),
					integerMap(form.get("menu_cups"), "menu_cups"),
					integerMap(form.get("manufacture_sec_by_menu"), "manufacture_sec_by_menu"),
					integerMap(form.get("orders_by_slot"), "orders_by_slot"),
					(String) form.get("peak_start_time"), (String) form.get("peak_end_time"),
					integer(form.get("espresso_machines")), integer(form.get("blenders")),
					integer(form.get("target_wait_sec")));
		}
		catch (ClassCastException | java.time.format.DateTimeParseException e) {
			throw ApiException.badRequest(CODE, "저장된 운영 조건을 읽지 못했어요. 조건을 다시 저장해 주세요.");
		}
	}

	private static Map<String, Integer> integerMap(Object value, String name) {
		if (value == null) {
			return null;
		}
		if (!(value instanceof Map<?, ?> raw)) {
			throw new ClassCastException(name);
		}
		Map<String, Integer> out = new LinkedHashMap<>();
		for (var e : raw.entrySet()) {
			out.put((String) e.getKey(), integer(e.getValue()));
		}
		return out;
	}

	private static boolean hasOrders(OperationInputDraftRequest form) {
		return form.dailyOrders() != null || (form.menuCups() != null && !form.menuCups().isEmpty())
				|| (form.ordersBySlot() != null && !form.ordersBySlot().isEmpty());
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
		return build(form, today, false);
	}

	/**
	 * 하루 근무표 만들기(ai-server /tools/simulation/daily-roster) 요청. 손님·메뉴 조건은 운영 비교와 같은 빌더로 만들고,
	 * 사람 조건(사장님 근무시간·시급·연소자)을 더한다. 근무표는 사람마다 근무조를 나누므로 연소자도 계산한다(긴 조를 줄임).
	 * 저장하지 않는 미리보기다.
	 */
	@SuppressWarnings("unchecked")
	public static Map<String, Object> rosterRequest(Map<String, Object> stored, String ownerStart, String ownerEnd,
			LocalDate today) {
		if (stored == null || !(stored.get(FORM_KEY) instanceof Map<?, ?> raw)) {
			throw ApiException.badRequest(CODE, "운영 조건(operation_form)을 보내 주세요.");
		}
		OperationInputDraftRequest form = fromForm(raw);
		Map<String, Object> input = build(form, today, true);
		Map<String, Object> simulation = new LinkedHashMap<>((Map<String, Object>) input.get("simulation"));
		simulation.remove("include_events");
		// 반복 수는 근무표 계산(ai-server roster_options.ROSTER_REPETITIONS)이 정한다. 1번 비교의 30번과 따로 둔다.
		simulation.remove("repetitions");
		Map<String, Object> scenario = (Map<String, Object>) simulation.get("scenario");
		String open = (String) scenario.getOrDefault("start_time", DAY_START);
		String close = (String) scenario.getOrDefault("end_time", DAY_END);
		Map<String, Object> owner = new LinkedHashMap<>();
		owner.put("is_working", form.isOwnerWorking());
		if (form.isOwnerWorking()) {
			String start = ownerStart == null || ownerStart.isBlank() ? open : ownerStart.trim();
			String end = ownerEnd == null || ownerEnd.isBlank() ? close : ownerEnd.trim();
			if (!start.matches("(?:[01][0-9]|2[0-3]):(?:00|30)") || !end.matches("(?:[01][0-9]|2[0-3]):(?:00|30)")
					|| start.compareTo(open) < 0 || end.compareTo(close) > 0 || start.compareTo(end) >= 0) {
				throw ApiException.badRequest(CODE, "사장님 근무시간은 영업시간(" + open + "~" + close + ") 안에서 30분 단위로 골라 주세요.");
			}
			owner.put("start_time", start);
			owner.put("end_time", end);
		}
		simulation.put("owner", owner);
		simulation.put("hourly_wage_krw", form.hourlyWageKrw());
		simulation.put("is_staff_minor", Boolean.TRUE.equals(form.isStaffMinor()));
		simulation.put("business_date", input.get("business_date"));
		return simulation;
	}

	static Map<String, Object> build(OperationInputDraftRequest form, LocalDate today, boolean roster) {
		if (form == null || !hasOrders(form) || form.isOwnerWorking() == null || form.hourlyWageKrw() == null) {
			throw ApiException.badRequest(CODE, "하루 주문 수, 사장님 근무 여부, 직원 시급을 입력해 주세요.");
		}
		Cups cups = cups(form.menuCups());
		Slots slots = slots(form.ordersBySlot());
		int dailyOrders = slots != null ? slots.total() : cups != null ? cups.total() : form.dailyOrders();
		if (dailyOrders < 1 || dailyOrders > MAX_DAILY_ORDERS) {
			throw ApiException.badRequest(CODE, slots != null
					? "시간대별 주문 합계(하루 주문 수)는 1~300건이어야 해요."
					: cups != null
					? "메뉴별 잔 수 합계(하루 주문 수)는 1~300잔으로 입력해 주세요."
					: "하루 주문 수는 1~300건으로 입력해 주세요.");
		}
		String open = slots != null ? slots.open() : hours(form.openTime(), DAY_START, "오픈", OPEN_MIN, OPEN_MAX);
		String close = slots != null ? slots.close() : hours(form.closeTime(), DAY_END, "마감", CLOSE_MIN, CLOSE_MAX);
		List<String> edges = slots != null ? slots.edges() : List.of(open, "11:00", "14:00", "17:00", close);
		String[] peak = peak(form.peakStartTime(), form.peakEndTime(), edges);
		LocalDate date = form.businessDate() != null ? form.businessDate() : today;
		Integer minimum = MINIMUM_WAGES.get(date.getYear());
		if (minimum == null) {
			throw ApiException.badRequest(CODE, date.getYear() + "년 최저시급 기준이 아직 없어요. 영업일을 확인해 주세요.");
		}
		if (form.hourlyWageKrw() < minimum) {
			throw ApiException.badRequest(CODE,
					String.format(Locale.KOREA, "직원 시급은 %d년 최저시급(%,d원) 이상으로 입력해 주세요.", date.getYear(), minimum));
		}
		String earliest = minus(close, 30);
		String lastOrder = time(form.lastOrderTime(), minus(close, 15), "라스트 오더", open, close);
		if (lastOrder.compareTo(earliest) < 0 || lastOrder.compareTo(close) > 0) {
			throw ApiException.badRequest(CODE, "라스트 오더는 " + earliest + "~" + close + " 사이로 골라 주세요.");
		}
		String rushStart = peak[0];
		String rushEnd = peak[1];
		boolean owner = form.isOwnerWorking();
		boolean minor = Boolean.TRUE.equals(form.isStaffMinor());
		if (minor && !roster) {
			// 근무표가 오픈~마감 한 근무라 연소자 하루 7시간 한도를 넘는다(영업시간은 최소 7시간). 노동 계산에서 막히기 전에 여기서 알린다.
			throw ApiException.badRequest(CODE, "연소자 직원은 하루 7시간까지만 일할 수 있어, 오픈부터 마감까지 근무로 비교하는 이번 운영 실험에서는 계산할 수 없어요.");
		}
		String lead = owner ? "OWNER" : "STAFF_1";
		String maker = owner ? "STAFF_1" : "STAFF_2";
		String extra = owner ? "STAFF_2" : "STAFF_3";

		List<Map<String, Object>> workers = new ArrayList<>();
		workers.add(worker(lead, owner, owner ? null : minor, owner ? null : form.hourlyWageKrw()));
		workers.add(worker(maker, false, minor, form.hourlyWageKrw()));
		workers.add(worker(extra, false, minor, form.hourlyWageKrw()));

		List<Map<String, Object>> plans = new ArrayList<>();
		plans.add(plan("CURRENT", List.of(new Shift(lead, open, close, "ORDER_HANDOFF"),
				new Shift(maker, open, close, "PREPARATION"))));
		List<Shift> altA = new ArrayList<>(helpInRush(lead, "ORDER_HANDOFF", "ORDER_HANDOFF_HELP_PREPARATION", rushStart, rushEnd, open, close));
		altA.addAll(helpInRush(maker, "PREPARATION", "PREPARATION_HELP_ORDER_HANDOFF", rushStart, rushEnd, open, close));
		plans.add(plan("ALT_A", altA));
		plans.add(plan("ALT_C", List.of(new Shift(lead, open, close, "ORDER_HANDOFF"),
				new Shift(maker, open, close, "PREPARATION"),
				new Shift(extra, rushStart, rushEnd, "PREPARATION_HELP_ORDER_HANDOFF"))));

		Map<String, Object> scenario = new LinkedHashMap<>();
		if (slots != null) {
			scenario.put("orders_by_slot", slots.counts());
		}
		else {
			scenario.put("daily_orders", dailyOrders);
		}
		if (!DAY_START.equals(open) || !DAY_END.equals(close)) {
			scenario.put("start_time", open);
			scenario.put("end_time", close);
		}
		if (!PEAK_START.equals(rushStart) || !PEAK_END.equals(rushEnd)) {
			scenario.put("peak_start_time", rushStart);
			scenario.put("peak_end_time", rushEnd);
		}
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
		List<String> selectedIds = cups != null ? cups.menuIds() : form.selectedMenuIds();
		Map<String, Double> menuWeights = cups != null ? cups.weights() : form.menuWeights();
		if (selectedIds != null && !selectedIds.isEmpty()) {
			if (selectedIds.stream().anyMatch(id -> id == null || !MENU_IDS.contains(id))) {
				throw ApiException.badRequest(CODE, "메뉴 선택을 다시 확인해 주세요.");
			}
			if (menuWeights == null || menuWeights.isEmpty()) {
				// 기본 비중이 0인 메뉴도 있어서, 메뉴를 고르면 비중도 같이 받아야 계산할 수 있다.
				throw ApiException.badRequest(CODE, "메뉴를 고르면 판매 비중도 함께 넣어 주세요.");
			}
			simulation.put("selected_menu_ids", List.copyOf(new TreeSet<>(selectedIds)));
		}
		if (menuWeights != null && !menuWeights.isEmpty()) {
			simulation.put("menu_weights", weights(menuWeights, selectedIds));
		}
		if (form.espressoMachines() != null || form.blenders() != null) {
			int espresso = machines(form.espressoMachines(), "에스프레소 머신");
			int blender = machines(form.blenders(), "블렌더");
			Map<String, Object> equipment = new LinkedHashMap<>();
			equipment.put("espresso", espresso);
			equipment.put("steam", espresso);
			equipment.put("blender", blender);
			simulation.put("equipment_counts", equipment);
		}
		if (form.targetWaitSec() != null) {
			if (form.targetWaitSec() < MIN_TARGET_WAIT_SEC || form.targetWaitSec() > MAX_TARGET_WAIT_SEC) {
				throw ApiException.badRequest(CODE, "목표 대기는 2~10분(120~600초)으로 골라 주세요.");
			}
			simulation.put("quality_targets", Map.of("max_p90_post_order_receipt_sec", form.targetWaitSec()));
		}
		if (form.manufactureSecByMenu() != null && !form.manufactureSecByMenu().isEmpty()) {
			simulation.put("manufacture_sec_by_menu", manufacture(form.manufactureSecByMenu(), selectedIds));
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

	/** 오픈~마감 근무를 바쁜 시간 앞·바쁜 시간(서로 돕기)·뒤로 나눈다. 사람과 근무시간은 그대로다. 길이 0인 구간은 뺀다. */
	static List<Shift> helpInRush(String worker, String task, String helpTask, String rushStart, String rushEnd) {
		return helpInRush(worker, task, helpTask, rushStart, rushEnd, DAY_START, DAY_END);
	}

	static List<Shift> helpInRush(String worker, String task, String helpTask, String rushStart, String rushEnd,
			String open, String close) {
		List<Shift> shifts = new ArrayList<>();
		if (open.compareTo(rushStart) < 0) {
			shifts.add(new Shift(worker, open, rushStart, task));
		}
		shifts.add(new Shift(worker, rushStart, rushEnd, helpTask));
		if (rushEnd.compareTo(close) < 0) {
			shifts.add(new Shift(worker, rushEnd, close, task));
		}
		return shifts;
	}

	/** 가게 시간대별 주문: 이어진 시간대(30분 단위 경계), 0 이상 정수. 영업시간은 처음·끝이다. */
	record Slots(String open, String close, List<String> edges, Map<String, Object> counts, int total) { }

	static Slots slots(Map<String, Integer> bySlot) {
		if (bySlot == null || bySlot.isEmpty()) {
			return null;
		}
		List<int[]> spans = new ArrayList<>();
		Map<Integer, Integer> countByStart = new java.util.HashMap<>();
		for (var e : bySlot.entrySet()) {
			String label = e.getKey();
			if (label == null || !label.matches("(?:[01][0-9]|2[0-3]):(?:00|30)-(?:[01][0-9]|2[0-3]):(?:00|30)")) {
				throw ApiException.badRequest(CODE, "시간대 이름은 30분 단위 HH:mm-HH:mm이어야 해요.");
			}
			int a = minutes(label.substring(0, 5));
			int b = minutes(label.substring(6));
			Integer n = e.getValue();
			if (n == null || n < 0) {
				throw ApiException.badRequest(CODE, "시간대별 주문 수는 0 이상의 정수로 넣어 주세요.");
			}
			spans.add(new int[] {a, b});
			countByStart.put(a, n);
		}
		spans.sort(java.util.Comparator.comparingInt(x -> x[0]));
		for (int i = 0; i < spans.size(); i++) {
			if (spans.get(i)[1] <= spans.get(i)[0] || (i > 0 && spans.get(i - 1)[1] != spans.get(i)[0])) {
				throw ApiException.badRequest(CODE, "시간대는 오픈부터 마감까지 빈틈없이 이어져야 해요.");
			}
		}
		String open = clock(spans.get(0)[0]);
		String close = clock(spans.get(spans.size() - 1)[1]);
		if (open.compareTo(STORE_OPEN_MIN) < 0 || close.compareTo(STORE_CLOSE_MAX) > 0
				|| minutes(close) - minutes(open) < STORE_MIN_HOURS * 60) {
			throw ApiException.badRequest(CODE, "영업시간은 " + STORE_OPEN_MIN + "~" + STORE_CLOSE_MAX + " 안에서 "
					+ STORE_MIN_HOURS + "시간 이상이어야 해요.");
		}
		List<String> edges = new ArrayList<>();
		Map<String, Object> counts = new LinkedHashMap<>();
		int total = 0;
		for (int[] span : spans) {
			edges.add(clock(span[0]));
			String label = clock(span[0]) + "-" + clock(span[1]);
			int n = countByStart.get(span[0]);
			counts.put(label, n);
			total += n;
		}
		edges.add(close);
		return new Slots(open, close, List.copyOf(edges), counts, total);
	}

	/** 바쁜 시간: 비우면 11~14시. 영업시간 안, 시간대 경계 위, 시작 < 끝. */
	static String[] peak(String start, String end, List<String> edges) {
		String s = start == null || start.isBlank() ? PEAK_START : start.trim();
		String e = end == null || end.isBlank() ? PEAK_END : end.trim();
		if (!edges.contains(s) || !edges.contains(e) || s.compareTo(e) >= 0) {
			throw ApiException.badRequest(CODE, "바쁜 시간은 영업시간 안에서 시간대 경계에 맞춰 골라 주세요.");
		}
		return new String[] {s, e};
	}

	private static int minutes(String hhmm) {
		return Integer.parseInt(hhmm.substring(0, 2)) * 60 + Integer.parseInt(hhmm.substring(3));
	}

	private static String clock(int minutes) {
		return String.format(Locale.ROOT, "%02d:%02d", minutes / 60, minutes % 60);
	}

	/** 메뉴별 잔 수 → 하루 주문 수(합계)·메뉴(잔 수가 1 이상인 메뉴)·판매 비중. */
	record Cups(int total, List<String> menuIds, Map<String, Double> weights) { }

	static Cups cups(Map<String, Integer> menuCups) {
		if (menuCups == null || menuCups.isEmpty()) {
			return null;
		}
		int total = 0;
		List<String> ids = new ArrayList<>();
		for (var e : new java.util.TreeMap<>(menuCups).entrySet()) {
			if (e.getKey() == null || !MENU_IDS.contains(e.getKey())) {
				throw ApiException.badRequest(CODE, "가게 데이터의 메뉴를 다시 확인해 주세요.");
			}
			Integer n = e.getValue();
			if (n == null || n < 0) {
				throw ApiException.badRequest(CODE, "메뉴별 잔 수는 0 이상의 정수로 넣어 주세요.");
			}
			total += n;
			if (n > 0) {
				ids.add(e.getKey());
			}
		}
		Map<String, Double> weights = new LinkedHashMap<>();
		for (String id : ids) {
			weights.put(id, menuCups.get(id) / (double) total);
		}
		return new Cups(total, ids, weights);
	}

	/** 메뉴별 제조시간: 고른 메뉴만(고른 메뉴가 없으면 엔진 기본 메뉴라 메뉴 목록만 본다), 10~600초. 메뉴 이름 순. */
	private static Map<String, Object> manufacture(Map<String, Integer> times, List<String> selected) {
		Map<String, Object> out = new LinkedHashMap<>();
		for (var e : new java.util.TreeMap<>(times).entrySet()) {
			String id = e.getKey();
			boolean known = selected != null && !selected.isEmpty() ? selected.contains(id) : MENU_IDS.contains(id);
			if (!known) {
				throw ApiException.badRequest(CODE, "제조시간은 파는 메뉴에만 넣어 주세요.");
			}
			Integer sec = e.getValue();
			if (sec == null || sec < MIN_MANUFACTURE_SEC || sec > MAX_MANUFACTURE_SEC) {
				throw ApiException.badRequest(CODE, "메뉴별 제조시간은 " + MIN_MANUFACTURE_SEC + "~" + MAX_MANUFACTURE_SEC + "초로 넣어 주세요.");
			}
			out.put(id, sec);
		}
		return out;
	}

	private static int machines(Integer value, String label) {
		int n = value == null ? 1 : value;
		if (n < 1 || n > MAX_MACHINES) {
			throw ApiException.badRequest(CODE, label + " 대수는 1~" + MAX_MACHINES + "대로 넣어 주세요.");
		}
		return n;
	}

	/** 오픈·마감: 범위 안, 30분 단위. */
	private static String hours(String value, String fallback, String label, String min, String max) {
		String text = value == null || value.isBlank() ? fallback : value.trim();
		if (!text.matches("(?:[01][0-9]|2[0-3]):(?:00|30)") || text.compareTo(min) < 0 || text.compareTo(max) > 0) {
			throw ApiException.badRequest(CODE, label + " 시각은 " + min + "~" + max + " 사이에서 30분 단위로 골라 주세요.");
		}
		return text;
	}

	/** 만든 입력의 영업시간 문구("07~19시", "08:30~20시"). 화면 설명용. */
	@SuppressWarnings("unchecked")
	public static String hoursText(Map<String, Object> input) {
		Map<String, Object> scenario = (Map<String, Object>) ((Map<String, Object>) input.get("simulation")).get("scenario");
		String open = (String) scenario.getOrDefault("start_time", DAY_START);
		String close = (String) scenario.getOrDefault("end_time", DAY_END);
		return shortClock(open) + "~" + shortClock(close) + "시";
	}

	private static String shortClock(String hhmm) {
		return hhmm.endsWith(":00") ? hhmm.substring(0, 2) : hhmm;
	}

	/** "19:00" - 15분 → "18:45". */
	static String minus(String hhmm, int minutes) {
		int total = Integer.parseInt(hhmm.substring(0, 2)) * 60 + Integer.parseInt(hhmm.substring(3)) - minutes;
		return String.format(Locale.ROOT, "%02d:%02d", total / 60, total % 60);
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

	private static String time(String value, String fallback, String label, String open, String close) {
		String text = value == null || value.isBlank() ? fallback : value.trim();
		if (!text.matches("(?:[01][0-9]|2[0-3]):[0-5][0-9]")) {
			throw ApiException.badRequest(CODE, label + " 시각은 HH:mm 형식이어야 해요.");
		}
		if (text.compareTo(open) < 0 || text.compareTo(close) > 0) {
			throw ApiException.badRequest(CODE, label + " 시각은 " + open + "~" + close + " 안에서 골라 주세요.");
		}
		return text;
	}
}
