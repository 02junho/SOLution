package com.solution.operation.service.input;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.junit.jupiter.api.Test;

import com.solution.common.exception.ApiException;
import com.solution.operation.dto.input.OperationInputDraftRequest;
import com.solution.operation.service.OperationResultContract;

@SuppressWarnings("unchecked")
class OperationInputBuilderTest {

	private static final LocalDate DAY = LocalDate.of(2026, 11, 18);

	private static OperationInputDraftRequest form(boolean owner) {
		return new OperationInputDraftRequest(null, 150, null, null, owner, 10320, null, null, null, null);
	}

	private static Map<String, Object> labor(Map<String, Object> input) {
		return (Map<String, Object>) input.get("labor");
	}

	private static List<Map<String, Object>> shifts(Map<String, Object> input, String choice) {
		return ((List<Map<String, Object>>) labor(input).get("plans")).stream()
				.filter(p -> choice.equals(p.get("choice_key"))).findFirst().map(p -> (List<Map<String, Object>>) p.get("shifts"))
				.orElseThrow();
	}

	@Test
	void 운영_계산이_읽는_칸을_모두_만든다() {
		Map<String, Object> input = OperationInputBuilder.build(form(true), DAY);
		assertThat(input).containsKeys("business_date", "wage_year", "assumptions_version", "simulation", "labor");
		assertThat(input.get("business_date")).isEqualTo("2026-11-18");
		assertThat(input.get("wage_year")).isEqualTo(2026);
		Map<String, Object> simulation = (Map<String, Object>) input.get("simulation");
		assertThat(simulation).containsEntry("repetitions", 30).containsEntry("include_events", true);
		assertThat((Map<String, Object>) simulation.get("scenario")).containsEntry("daily_orders", 150)
				.containsEntry("last_order_time", "18:45");
		assertThat(labor(input)).containsEntry("rule_policy_version", "labor.kr.2026.v1");
		// Spring 계약 검사(세 안, 문자열 근무 칸)를 그대로 통과한다.
		assertThat(OperationResultContract.staffing(labor(input).get("plans"))).hasSize(3);
	}

	@Test
	void 사장님이_일하면_주문_담당이고_급여에서_빠진다() {
		Map<String, Object> input = OperationInputBuilder.build(form(true), DAY);
		List<Map<String, Object>> workers = (List<Map<String, Object>>) labor(input).get("workers");
		assertThat(workers.get(0)).containsEntry("worker_key", "OWNER").containsEntry("is_owner", true)
				.containsEntry("hourly_wage_krw", null);
		assertThat(shifts(input, "CURRENT")).extracting(s -> s.get("worker_key")).containsExactly("OWNER", "STAFF_1");
	}

	@Test
	void 사장님이_일하지_않으면_직원_두_명이_하루를_맡는다() {
		Map<String, Object> input = OperationInputBuilder.build(form(false), DAY);
		List<Map<String, Object>> workers = (List<Map<String, Object>>) labor(input).get("workers");
		assertThat(workers).extracting(w -> w.get("is_owner")).containsOnly(false);
		assertThat(shifts(input, "CURRENT")).extracting(s -> s.get("worker_key")).containsExactly("STAFF_1", "STAFF_2");
	}

	@Test
	void 바쁜_시간은_입력이_아니라_상권_데이터의_가장_바쁜_시간대다() throws Exception {
		// 손님 몰림은 엔진이 demand_shares.json으로 정한다. 서로 돕기·한 명 추가·휴게 피하기도 같은 시간대를 써야 맞는다.
		String shares = Files.readString(Path.of("../ai-server/app/tools/simulation/data/demand_shares.json"));
		Matcher block = Pattern.compile("\"normalized_shares\"\\s*:\\s*\\{([^}]*)\\}").matcher(shares);
		assertThat(block.find()).isTrue();
		Matcher band = Pattern.compile("\"(\\d{2}):00-(\\d{2}):00\"\\s*:\\s*([0-9.eE-]+)").matcher(block.group(1));
		String busiest = null;
		double best = -1;
		while (band.find()) {
			int hours = Integer.parseInt(band.group(2)) - Integer.parseInt(band.group(1));
			double perHour = Double.parseDouble(band.group(3)) / hours;
			if (perHour > best) {
				best = perHour;
				busiest = band.group(1) + ":00-" + band.group(2) + ":00";
			}
		}
		assertThat(busiest).isEqualTo(OperationInputBuilder.PEAK_START + "-" + OperationInputBuilder.PEAK_END);
	}

	@Test
	void 저장된_폼_값은_계산할_때_근무표_세_안까지_만든다() {
		Map<String, Object> stored = Map.of(OperationInputBuilder.FORM_KEY,
				Map.of("daily_orders", 150, "is_owner_working", true, "hourly_wage_krw", 10320));
		assertThat(OperationInputBuilder.expand(stored, DAY)).isEqualTo(OperationInputBuilder.build(form(true), DAY));
		// JSON에서 읽은 숫자(150.0)도 정수로 받는다.
		Map<String, Object> fromJson = Map.of(OperationInputBuilder.FORM_KEY,
				Map.of("daily_orders", 150.0, "is_owner_working", true, "hourly_wage_krw", 10320L));
		assertThat(OperationInputBuilder.expand(fromJson, DAY)).isEqualTo(OperationInputBuilder.build(form(true), DAY));
	}

	@Test
	void 필수_값이_빠진_폼과_예전_완성본은_그대로_둔다() {
		Map<String, Object> partial = Map.of(OperationInputBuilder.FORM_KEY, Map.of("daily_orders", 150));
		assertThat(OperationInputBuilder.expand(partial, DAY)).isSameAs(partial);
		Map<String, Object> built = OperationInputBuilder.build(form(true), DAY);
		assertThat(OperationInputBuilder.expand(built, DAY)).isSameAs(built);
	}

	@Test
	void 저장된_폼_값의_모양이_틀리면_400() {
		Map<String, Object> wrong = Map.of(OperationInputBuilder.FORM_KEY,
				Map.of("daily_orders", "많이", "is_owner_working", true, "hourly_wage_krw", 10320));
		assertThatThrownBy(() -> OperationInputBuilder.expand(wrong, DAY)).isInstanceOf(ApiException.class);
		Map<String, Object> fraction = Map.of(OperationInputBuilder.FORM_KEY,
				Map.of("daily_orders", 150.5, "is_owner_working", true, "hourly_wage_krw", 10320));
		assertThatThrownBy(() -> OperationInputBuilder.expand(fraction, DAY)).isInstanceOf(ApiException.class);
		// 메뉴 칸도 값이 있는데 배열·맵이 아니면 조용히 넘기지 않고 400.
		Map<String, Object> menusNotList = Map.of(OperationInputBuilder.FORM_KEY, Map.of("daily_orders", 150,
				"is_owner_working", true, "hourly_wage_krw", 10320, "selected_menu_ids", "iced_americano"));
		assertThatThrownBy(() -> OperationInputBuilder.expand(menusNotList, DAY)).isInstanceOf(ApiException.class);
		Map<String, Object> weightsNotMap = Map.of(OperationInputBuilder.FORM_KEY, Map.of("daily_orders", 150,
				"is_owner_working", true, "hourly_wage_krw", 10320, "menu_weights", List.of(0.5, 0.5)));
		assertThatThrownBy(() -> OperationInputBuilder.expand(weightsNotMap, DAY)).isInstanceOf(ApiException.class);
	}

	@Test
	void 메뉴_칸이_없거나_null이면_생략으로_본다() {
		Map<String, Object> form = new HashMap<>(Map.of("daily_orders", 150, "is_owner_working", true, "hourly_wage_krw", 10320));
		form.put("selected_menu_ids", null);
		form.put("menu_weights", null);
		assertThat(OperationInputBuilder.expand(Map.of(OperationInputBuilder.FORM_KEY, form), DAY))
				.isEqualTo(OperationInputBuilder.build(form(true), DAY));
	}

	@Test
	void 빠진_필수_값은_operation_form_경로로_알려_준다() {
		Map<String, Object> partial = Map.of(OperationInputBuilder.FORM_KEY, Map.of("daily_orders", 150));
		assertThat(OperationInputBuilder.missingFormFields(partial).stream().map(row -> row.get("path")).toList())
				.containsExactly("operation_form.is_owner_working", "operation_form.hourly_wage_krw");
		assertThat(OperationInputBuilder.missingFormFields(Map.of(OperationInputBuilder.FORM_KEY, Map.of()))
				.stream().map(row -> row.get("label")).toList())
				.containsExactly("하루 주문 수", "사장님 근무 여부", "직원 시급");
		Map<String, Object> full = Map.of(OperationInputBuilder.FORM_KEY,
				Map.of("daily_orders", 150, "is_owner_working", true, "hourly_wage_krw", 10320));
		assertThat(OperationInputBuilder.missingFormFields(full)).isEmpty();
		assertThat(OperationInputBuilder.missingFormFields(OperationInputBuilder.build(form(true), DAY))).isEmpty();
	}

	@Test
	void 기본_두_명은_07시부터_19시까지_일한다() {
		Map<String, Object> input = OperationInputBuilder.build(form(true), DAY);
		assertThat(shifts(input, "CURRENT")).allSatisfy(s -> assertThat(s).containsEntry("start_time", "07:00")
				.containsEntry("end_time", "19:00"));
		assertThat(shifts(input, "CURRENT")).extracting(s -> s.get("task_code")).containsExactly("ORDER_HANDOFF", "PREPARATION");
		assertThat((List<Map<String, Object>>) labor(input).get("avoid_break_windows"))
				.containsExactly(Map.of("start_time", "11:00", "end_time", "14:00"));
	}

	@Test
	void A안은_바쁜_시간에만_서로_돕고_사람과_시간은_같다() {
		Map<String, Object> input = OperationInputBuilder.build(form(true), DAY);
		List<Map<String, Object>> altA = shifts(input, "ALT_A");
		assertThat(altA).extracting(s -> s.get("task_code")).containsExactly("ORDER_HANDOFF",
				"ORDER_HANDOFF_HELP_PREPARATION", "ORDER_HANDOFF", "PREPARATION", "PREPARATION_HELP_ORDER_HANDOFF",
				"PREPARATION");
		assertThat(altA.get(1)).containsEntry("start_time", "11:00").containsEntry("end_time", "14:00");
	}

	@Test
	void C안은_바쁜_시간에_한_명을_더한다() {
		Map<String, Object> input = OperationInputBuilder.build(form(true), DAY);
		List<Map<String, Object>> altC = shifts(input, "ALT_C");
		assertThat(altC).hasSize(3);
		assertThat(altC.get(2)).containsEntry("worker_key", "STAFF_2").containsEntry("start_time", "11:00")
				.containsEntry("end_time", "14:00").containsEntry("task_code", "PREPARATION_HELP_ORDER_HANDOFF");
	}

	@Test
	void 같은_사람의_근무는_끊기지_않고_이어진다() {
		Map<String, Object> input = OperationInputBuilder.build(form(true), DAY);
		for (String choice : List.of("CURRENT", "ALT_A", "ALT_C")) {
			Map<String, String> lastEnd = new java.util.HashMap<>();
			for (Map<String, Object> shift : shifts(input, choice)) {
				String worker = (String) shift.get("worker_key");
				if (lastEnd.containsKey(worker)) {
					assertThat(shift.get("start_time")).isEqualTo(lastEnd.get(worker));
				}
				lastEnd.put(worker, (String) shift.get("end_time"));
			}
		}
	}

	@Test
	void 라스트_오더는_18시30분부터_19시까지만_받는다() {
		var early = new OperationInputDraftRequest(null, 150, "18:00", null, true, 10320, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(early, DAY)).isInstanceOf(ApiException.class)
				.hasMessageContaining("18:30");
	}

	@Test
	void 시급은_그해_최저시급_이상이어야_한다() {
		var low = new OperationInputDraftRequest(null, 150, null, null, true, 9000, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(low, DAY)).isInstanceOf(ApiException.class)
				.hasMessageContaining("10,320");
		var nextYear = new OperationInputDraftRequest(LocalDate.of(2027, 1, 4), 150, null, null, true, 10320, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(nextYear, DAY)).hasMessageContaining("10,700");
		var unknownYear = new OperationInputDraftRequest(LocalDate.of(2030, 1, 2), 150, null, null, true, 20000, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(unknownYear, DAY)).hasMessageContaining("2030");
	}

	@Test
	void 시각_형식을_검사한다() {
		var wrong = new OperationInputDraftRequest(null, 150, "9시", null, true, 10320, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(wrong, DAY)).isInstanceOf(ApiException.class)
				.hasMessageContaining("HH:mm");
	}

	@Test
	void 주문_수는_300건까지() {
		var many = new OperationInputDraftRequest(null, 301, null, null, true, 10320, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(many, DAY)).isInstanceOf(ApiException.class);
	}

	@Test
	void 판매_비중은_고른_메뉴와_같고_합계가_100이어야_한다() {
		var ok = new OperationInputDraftRequest(null, 150, null, List.of("iced_cafe_latte", "iced_americano"), true, 10320, null,
				Map.of("iced_americano", 0.6, "iced_cafe_latte", 0.4), 50, 25);
		Map<String, Object> simulation = (Map<String, Object>) OperationInputBuilder.build(ok, DAY).get("simulation");
		assertThat(simulation.get("selected_menu_ids")).isEqualTo(List.of("iced_americano", "iced_cafe_latte"));
		assertThat((Map<String, Object>) simulation.get("menu_weights")).containsEntry("iced_americano", 0.6)
				.containsEntry("iced_cafe_latte", 0.4);
		assertThat(simulation).containsEntry("order_time_sec", 50).containsEntry("handoff_time_sec", 25);
		var wrongSum = new OperationInputDraftRequest(null, 150, null, List.of("iced_cafe_latte", "iced_americano"), true, 10320,
				null, Map.of("iced_americano", 0.6, "iced_cafe_latte", 0.3), null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(wrongSum, DAY)).hasMessageContaining("100%");
		var extraMenu = new OperationInputDraftRequest(null, 150, null, List.of("iced_cafe_latte"), true, 10320, null,
				Map.of("iced_americano", 0.5, "iced_cafe_latte", 0.5), null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(extraMenu, DAY)).hasMessageContaining("고른 메뉴");
	}

	@Test
	void 메뉴를_고르면_비중도_있어야_한다() {
		// 기본 비중이 0인 메뉴(hot_americano)만 고르면 계산 단계에서 막히므로 초안에서 먼저 거부한다.
		var noWeights = new OperationInputDraftRequest(null, 150, null, List.of("hot_americano"), true, 10320, null,
				null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(noWeights, DAY)).hasMessageContaining("판매 비중");
	}

	@Test
	void 엔진에_없는_메뉴는_거부한다() {
		var unknown = new OperationInputDraftRequest(null, 150, null, List.of("latte"), true, 10320, null,
				Map.of("latte", 1.0), null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(unknown, DAY)).hasMessageContaining("메뉴");
	}

	@Test
	void 메뉴_목록은_엔진_메뉴_목록과_같다() throws Exception {
		String catalog = Files.readString(Path.of("../ai-server/app/tools/simulation/menu_catalog.json"));
		Set<String> engine = new TreeSet<>();
		Matcher m = Pattern.compile("\"menu_id\"\\s*:\\s*\"([^\"]+)\"").matcher(catalog);
		while (m.find()) {
			engine.add(m.group(1));
		}
		assertThat(new TreeSet<>(OperationInputBuilder.MENU_IDS)).isEqualTo(engine);
	}

	@Test
	void 연소자_직원은_계산할_수_없다고_알린다() {
		// 07-19시 근무는 연소자 하루 7시간 한도를 넘어 노동 계산에서 막힌다.
		var minor = new OperationInputDraftRequest(null, 150, null, null, false, 10320, true, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(minor, DAY)).hasMessageContaining("연소자");
	}

	// ---------------------------------------------------------------- 가게 데이터 버전

	private static OperationInputDraftRequest store(String open, String close, Map<String, Integer> cups,
			Map<String, Integer> manufacture) {
		return new OperationInputDraftRequest(null, null, null, null, true, 10320, null, null, null, null, open, close,
				cups, manufacture);
	}

	private static Map<String, Object> simulation(Map<String, Object> input) {
		return (Map<String, Object>) input.get("simulation");
	}

	@Test
	void 영업시간을_안_넣으면_지금_버전과_같은_입력이다() {
		var now = OperationInputBuilder.build(form(true), DAY);
		var withNulls = OperationInputBuilder.build(new OperationInputDraftRequest(null, 150, null, null, true, 10320,
				null, null, null, null, null, null, null, null), DAY);
		assertThat(withNulls).isEqualTo(now);
		assertThat((Map<String, Object>) simulation(now).get("scenario")).doesNotContainKeys("start_time", "end_time");
	}

	@Test
	void 영업시간을_바꾸면_근무와_라스트_오더가_따라간다() {
		var input = OperationInputBuilder.build(store("08:00", "20:00", Map.of("iced_americano", 100), null), DAY);
		Map<String, Object> scenario = (Map<String, Object>) simulation(input).get("scenario");
		assertThat(scenario).containsEntry("start_time", "08:00").containsEntry("end_time", "20:00")
				.containsEntry("last_order_time", "19:45");
		assertThat(shifts(input, "CURRENT")).extracting(s -> s.get("start_time") + "-" + s.get("end_time"))
				.containsExactly("08:00-20:00", "08:00-20:00");
		assertThat(shifts(input, "ALT_A")).extracting(s -> s.get("start_time") + "-" + s.get("end_time"))
				.containsExactly("08:00-11:00", "11:00-14:00", "14:00-20:00", "08:00-11:00", "11:00-14:00", "14:00-20:00");
		assertThat(OperationResultContract.staffing(labor(input).get("plans"))).hasSize(3);
	}

	@Test
	void 영업시간은_상권_데이터_범위와_30분_단위만_받는다() {
		for (String[] bad : new String[][] {{"05:30", "19:00"}, {"11:00", "19:00"}, {"07:15", "19:00"},
				{"07:00", "17:00"}, {"07:00", "21:30"}}) {
			assertThatThrownBy(() -> OperationInputBuilder.build(store(bad[0], bad[1], Map.of("iced_americano", 50), null), DAY))
					.isInstanceOf(ApiException.class).hasMessageContaining("시각은");
		}
		var late = new OperationInputDraftRequest(null, 100, "19:00", null, true, 10320, null, null, null, null,
				"08:00", "20:00", null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(late, DAY)).hasMessageContaining("19:30~20:00");
	}

	@Test
	void 메뉴별_잔_수로_하루_주문과_판매_비중을_정한다() {
		var cups = new HashMap<String, Integer>();
		cups.put("iced_americano", 60);
		cups.put("iced_cafe_latte", 30);
		cups.put("hot_americano", 10);
		cups.put("iced_milk_tea", 0);
		var input = OperationInputBuilder.build(store(null, null, cups, null), DAY);
		Map<String, Object> sim = simulation(input);
		assertThat((Map<String, Object>) sim.get("scenario")).containsEntry("daily_orders", 100);
		assertThat(sim.get("selected_menu_ids")).isEqualTo(List.of("hot_americano", "iced_americano", "iced_cafe_latte"));
		assertThat((Map<String, Object>) sim.get("menu_weights")).containsEntry("iced_americano", 0.6)
				.containsEntry("iced_cafe_latte", 0.3).containsEntry("hot_americano", 0.1);
	}

	@Test
	void 잔_수_합계도_300잔까지다() {
		assertThatThrownBy(() -> OperationInputBuilder.build(store(null, null, Map.of("iced_americano", 301), null), DAY))
				.hasMessageContaining("1~300잔");
		assertThatThrownBy(() -> OperationInputBuilder.build(store(null, null, Map.of("latte", 10), null), DAY))
				.hasMessageContaining("메뉴");
	}

	@Test
	void 메뉴별_제조시간은_파는_메뉴에만_10초에서_600초() {
		var input = OperationInputBuilder.build(store(null, null, Map.of("iced_americano", 80, "hot_americano", 20),
				Map.of("iced_americano", 75)), DAY);
		assertThat((Map<String, Object>) simulation(input).get("manufacture_sec_by_menu")).containsEntry("iced_americano", 75);
		assertThatThrownBy(() -> OperationInputBuilder.build(store(null, null, Map.of("iced_americano", 80),
				Map.of("hot_americano", 75)), DAY)).hasMessageContaining("파는 메뉴");
		assertThatThrownBy(() -> OperationInputBuilder.build(store(null, null, Map.of("iced_americano", 80),
				Map.of("iced_americano", 5)), DAY)).hasMessageContaining("10~600초");
	}

	@Test
	void 저장된_가게_데이터를_읽어_계산_입력을_만든다() {
		Map<String, Object> form = new HashMap<>();
		form.put("is_owner_working", true);
		form.put("hourly_wage_krw", 10320);
		form.put("open_time", "08:00");
		form.put("close_time", "20:00");
		form.put("menu_cups", Map.of("iced_americano", 70, "iced_cafe_latte", 30));
		form.put("manufacture_sec_by_menu", Map.of("iced_cafe_latte", 90.0));
		Map<String, Object> stored = Map.of(OperationInputBuilder.FORM_KEY, form);
		assertThat(OperationInputBuilder.missingFormFields(stored)).isEmpty();
		Map<String, Object> input = OperationInputBuilder.expand(stored, DAY);
		assertThat((Map<String, Object>) simulation(input).get("scenario")).containsEntry("daily_orders", 100)
				.containsEntry("start_time", "08:00");
		assertThat((Map<String, Object>) simulation(input).get("manufacture_sec_by_menu")).containsEntry("iced_cafe_latte", 90);
	}

	// ---------------------------------------------------------------- 가게 시간대·바쁜 시간

	private static Map<String, Integer> hourly() {
		Map<String, Integer> slots = new java.util.LinkedHashMap<>();
		int[] counts = {12, 15, 10, 8, 20, 18, 9, 6, 5, 6, 4, 3};
		for (int i = 0; i < counts.length; i++) {
			slots.put(String.format("%02d:00-%02d:00", 8 + i, 9 + i), counts[i]);
		}
		return slots;
	}

	private static OperationInputDraftRequest slotted(Map<String, Integer> slots, String peakStart, String peakEnd,
			Map<String, Integer> cups) {
		return new OperationInputDraftRequest(null, null, null, null, true, 10320, null, null, null, null, null, null,
				cups, null, slots, peakStart, peakEnd);
	}

	@Test
	void 시간대별_주문으로_영업시간과_하루_주문을_정한다() {
		var input = OperationInputBuilder.build(slotted(hourly(), "12:00", "14:00", Map.of("iced_americano", 7, "hot_americano", 3)), DAY);
		Map<String, Object> scenario = (Map<String, Object>) simulation(input).get("scenario");
		assertThat(scenario).doesNotContainKey("daily_orders").containsEntry("start_time", "08:00")
				.containsEntry("end_time", "20:00").containsEntry("last_order_time", "19:45")
				.containsEntry("peak_start_time", "12:00").containsEntry("peak_end_time", "14:00");
		assertThat((Map<String, Object>) scenario.get("orders_by_slot")).hasSize(12).containsEntry("12:00-13:00", 20);
		// 잔 수는 판매 비중에만 쓴다(하루 주문은 시간대 합계 116건).
		assertThat((Map<String, Object>) simulation(input).get("menu_weights")).containsEntry("iced_americano", 0.7);
		assertThat(shifts(input, "ALT_C").get(2)).containsEntry("start_time", "12:00").containsEntry("end_time", "14:00");
		assertThat(shifts(input, "ALT_A")).extracting(s -> s.get("start_time") + "-" + s.get("end_time"))
				.containsExactly("08:00-12:00", "12:00-14:00", "14:00-20:00", "08:00-12:00", "12:00-14:00", "14:00-20:00");
		assertThat((List<Map<String, Object>>) labor(input).get("avoid_break_windows"))
				.containsExactly(Map.of("start_time", "12:00", "end_time", "14:00"));
	}

	@Test
	void 시간대는_이어지고_바쁜_시간은_경계_위여야_한다() {
		Map<String, Integer> gap = new java.util.LinkedHashMap<>(hourly());
		gap.remove("10:00-11:00");
		assertThatThrownBy(() -> OperationInputBuilder.build(slotted(gap, null, null, null), DAY)).hasMessageContaining("빈틈");
		assertThatThrownBy(() -> OperationInputBuilder.build(slotted(hourly(), "12:30", "14:00", null), DAY))
				.hasMessageContaining("바쁜 시간");
		assertThatThrownBy(() -> OperationInputBuilder.build(slotted(Map.of("08:00-10:00", 5), null, null, null), DAY))
				.hasMessageContaining("시간 이상");
		Map<String, Integer> many = new java.util.LinkedHashMap<>(hourly());
		many.put("12:00-13:00", 300);
		assertThatThrownBy(() -> OperationInputBuilder.build(slotted(many, null, null, null), DAY)).hasMessageContaining("1~300건");
	}

	@Test
	void 바쁜_시간만_바꿔도_근무표가_따라간다() {
		var input = OperationInputBuilder.build(new OperationInputDraftRequest(null, 120, null, null, true, 10320, null,
				null, null, null, null, null, null, null, null, "14:00", "17:00"), DAY);
		assertThat(shifts(input, "ALT_C").get(2)).containsEntry("start_time", "14:00").containsEntry("end_time", "17:00");
		assertThat((Map<String, Object>) simulation(input).get("scenario")).containsEntry("peak_start_time", "14:00");
	}

	@Test
	void 저장된_시간대별_주문만으로도_계산할_수_있다() {
		Map<String, Object> form = new HashMap<>();
		form.put("is_owner_working", true);
		form.put("hourly_wage_krw", 10320);
		form.put("orders_by_slot", hourly());
		form.put("peak_start_time", "12:00");
		form.put("peak_end_time", "14:00");
		form.put("store_source", Map.of("file_name", "sales.csv", "rows_read", 1624));
		Map<String, Object> stored = Map.of(OperationInputBuilder.FORM_KEY, form);
		assertThat(OperationInputBuilder.missingFormFields(stored)).isEmpty();
		assertThat((Map<String, Object>) simulation(OperationInputBuilder.expand(stored, DAY)).get("scenario"))
				.containsKey("orders_by_slot");
	}

	@Test
	void 기계_대수와_목표_대기를_엔진에_넘긴다() {
		var form = new OperationInputDraftRequest(null, 150, null, null, true, 10320, null, null, null, null, null, null,
				null, null, null, null, null, 2, 1, 180);
		Map<String, Object> sim = simulation(OperationInputBuilder.build(form, DAY));
		assertThat((Map<String, Object>) sim.get("equipment_counts")).containsEntry("espresso", 2).containsEntry("steam", 2)
				.containsEntry("blender", 1);
		assertThat((Map<String, Object>) sim.get("quality_targets")).containsEntry("max_p90_post_order_receipt_sec", 180);
		var bad = new OperationInputDraftRequest(null, 150, null, null, true, 10320, null, null, null, null, null, null,
				null, null, null, null, null, 4, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(bad, DAY)).hasMessageContaining("1~3대");
		var slow = new OperationInputDraftRequest(null, 150, null, null, true, 10320, null, null, null, null, null, null,
				null, null, null, null, null, null, null, 900);
		assertThatThrownBy(() -> OperationInputBuilder.build(slow, DAY)).hasMessageContaining("2~10분");
		assertThat(simulation(OperationInputBuilder.build(form(true), DAY))).doesNotContainKeys("equipment_counts", "quality_targets");
	}
}
