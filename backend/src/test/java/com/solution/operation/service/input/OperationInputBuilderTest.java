package com.solution.operation.service.input;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
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
		return new OperationInputDraftRequest(null, 150, null, null, owner, 10320, null, null, null, null, null, null);
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
	void 바쁜_시간을_바꾸면_서로_돕기와_한_명_추가_구간과_휴게_피할_시간이_같이_바뀐다() {
		var rush = new OperationInputDraftRequest(null, 150, null, null, true, 10320, null, "12:00", "15:30", null, null, null);
		Map<String, Object> input = OperationInputBuilder.build(rush, DAY);
		assertThat(shifts(input, "ALT_A")).filteredOn(s -> "OWNER".equals(s.get("worker_key")))
				.extracting(s -> s.get("start_time") + "-" + s.get("end_time"))
				.containsExactly("07:00-12:00", "12:00-15:30", "15:30-19:00");
		assertThat(shifts(input, "ALT_C")).filteredOn(s -> "STAFF_2".equals(s.get("worker_key")))
				.extracting(s -> s.get("start_time") + "-" + s.get("end_time")).containsExactly("12:00-15:30");
		assertThat((List<Map<String, Object>>) labor(input).get("avoid_break_windows"))
				.containsExactly(Map.of("start_time", "12:00", "end_time", "15:30"));
		var reversed = new OperationInputDraftRequest(null, 150, null, null, true, 10320, null, "14:00", "11:00", null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(reversed, DAY)).hasMessageContaining("늦게");
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
		var early = new OperationInputDraftRequest(null, 150, "18:00", null, true, 10320, null, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(early, DAY)).isInstanceOf(ApiException.class)
				.hasMessageContaining("18:30");
	}

	@Test
	void 시급은_그해_최저시급_이상이어야_한다() {
		var low = new OperationInputDraftRequest(null, 150, null, null, true, 9000, null, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(low, DAY)).isInstanceOf(ApiException.class)
				.hasMessageContaining("10,320");
		var nextYear = new OperationInputDraftRequest(LocalDate.of(2027, 1, 4), 150, null, null, true, 10320, null, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(nextYear, DAY)).hasMessageContaining("10,700");
		var unknownYear = new OperationInputDraftRequest(LocalDate.of(2030, 1, 2), 150, null, null, true, 20000, null, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(unknownYear, DAY)).hasMessageContaining("2030");
	}

	@Test
	void 시각_형식을_검사한다() {
		var wrong = new OperationInputDraftRequest(null, 150, "9시", null, true, 10320, null, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(wrong, DAY)).isInstanceOf(ApiException.class)
				.hasMessageContaining("HH:mm");
	}

	@Test
	void 주문_수는_300건까지() {
		var many = new OperationInputDraftRequest(null, 301, null, null, true, 10320, null, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(many, DAY)).isInstanceOf(ApiException.class);
	}

	@Test
	void 판매_비중은_고른_메뉴와_같고_합계가_100이어야_한다() {
		var ok = new OperationInputDraftRequest(null, 150, null, List.of("iced_cafe_latte", "iced_americano"), true, 10320, null,
				null, null, Map.of("iced_americano", 0.6, "iced_cafe_latte", 0.4), 50, 25);
		Map<String, Object> simulation = (Map<String, Object>) OperationInputBuilder.build(ok, DAY).get("simulation");
		assertThat(simulation.get("selected_menu_ids")).isEqualTo(List.of("iced_americano", "iced_cafe_latte"));
		assertThat((Map<String, Object>) simulation.get("menu_weights")).containsEntry("iced_americano", 0.6)
				.containsEntry("iced_cafe_latte", 0.4);
		assertThat(simulation).containsEntry("order_time_sec", 50).containsEntry("handoff_time_sec", 25);
		var wrongSum = new OperationInputDraftRequest(null, 150, null, List.of("iced_cafe_latte", "iced_americano"), true, 10320,
				null, null, null, Map.of("iced_americano", 0.6, "iced_cafe_latte", 0.3), null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(wrongSum, DAY)).hasMessageContaining("100%");
		var extraMenu = new OperationInputDraftRequest(null, 150, null, List.of("iced_cafe_latte"), true, 10320, null, null, null,
				Map.of("iced_americano", 0.5, "iced_cafe_latte", 0.5), null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(extraMenu, DAY)).hasMessageContaining("고른 메뉴");
	}

	@Test
	void 메뉴를_고르면_비중도_있어야_한다() {
		// 기본 비중이 0인 메뉴(hot_americano)만 고르면 계산 단계에서 막히므로 초안에서 먼저 거부한다.
		var noWeights = new OperationInputDraftRequest(null, 150, null, List.of("hot_americano"), true, 10320, null, null, null,
				null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(noWeights, DAY)).hasMessageContaining("판매 비중");
	}

	@Test
	void 엔진에_없는_메뉴는_거부한다() {
		var unknown = new OperationInputDraftRequest(null, 150, null, List.of("latte"), true, 10320, null, null, null,
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
		var minor = new OperationInputDraftRequest(null, 150, null, null, false, 10320, true, null, null, null, null, null);
		assertThatThrownBy(() -> OperationInputBuilder.build(minor, DAY)).hasMessageContaining("연소자");
	}
}
