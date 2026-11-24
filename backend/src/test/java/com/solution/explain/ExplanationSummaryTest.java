package com.solution.explain;

import static org.assertj.core.api.Assertions.assertThat;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

@SuppressWarnings("unchecked")
class ExplanationSummaryTest {

	private final JsonMapper json = JsonMapper.builder().build();

	private Map<String, Object> read(String text) {
		return json.readValue(text.replace('\'', '"'), new TypeReference<Map<String, Object>>() { });
	}

	@Test
	void 구매는_안별_총액_배송_거래처와_기준선_경고만_넘긴다() {
		Map<String, Object> stored = read("""
				{'choices': [
				  {'choice_key': 'purchase_1', 'label': '총비용 최소', 'available': true, 'total_krw': 113280,
				   'goods_krw': 110280, 'delivery_count': 2, 'warning_ids': [],
				   'supplier_totals': [{'supplier_id': 'R3', 'supplier_name': '원두 로스터리 다', 'goods_krw': 60200}],
				   'constraints_met': {'budget': true}},
				  {'choice_key': 'purchase_2', 'label': '배송 1회', 'available': false, 'total_krw': null}],
				 'baseline': {'label': '단위단가순 담기 (비교용)', 'total_krw': 166090, 'confirmable': false},
				 'warnings': [{'warning_id': 'VAT_UNKNOWN', 'message': '부가세 확인', 'requires_ack': true, 'extra': 1}],
				 'assumptions': ['거래처 1곳 = 배송 1회']}""");

		Map<String, Object> summary = ExplanationSummary.purchase(stored);

		List<Map<String, Object>> choices = (List<Map<String, Object>>) summary.get("choices");
		assertThat(choices).hasSize(1);
		assertThat(choices.get(0)).containsOnlyKeys("choice_key", "label", "total_krw", "delivery_count",
				"warning_ids", "suppliers")
				.containsEntry("total_krw", 113280).containsEntry("suppliers", List.of("원두 로스터리 다"))
				// 설명에는 쉬운 화면과 같은 안 이름으로 넘긴다(저장된 "총비용 최소"가 아니라)
				.containsEntry("label", "가장 싸게");
		assertThat((Map<String, Object>) summary.get("baseline")).containsEntry("total_krw", 166090)
				.containsEntry("label", "단가만 보고 고르면(비교용)")
				.containsEntry("confirmable", false);
		assertThat((List<Map<String, Object>>) summary.get("warnings")).singleElement()
				.satisfies(w -> assertThat(w).containsOnlyKeys("warning_id", "message", "requires_ack"));
		assertThat(summary.get("assumptions")).isEqualTo(List.of("거래처 1곳 = 배송 1회"));
	}

	@Test
	void 같은_조합인_안은_가리키는_안의_금액과_배송과_거래처를_채운다() {
		Map<String, Object> stored = read("""
				{'choices': [
				  {'choice_key': 'purchase_1', 'label': '총비용 최소', 'available': true, 'total_krw': 120400,
				   'delivery_count': 1, 'warning_ids': ['VAT_UNKNOWN'],
				   'supplier_totals': [{'supplier_name': '카페 도매몰'}]},
				  {'choice_key': 'purchase_2', 'label': '배송 1회', 'available': true, 'same_as': 'purchase_1'},
				  {'choice_key': 'purchase_3', 'label': '고리', 'available': true, 'same_as': 'purchase_3'}],
				 'warnings': [], 'assumptions': []}""");

		List<Map<String, Object>> choices = (List<Map<String, Object>>) ExplanationSummary.purchase(stored).get("choices");

		assertThat(choices.get(1)).containsEntry("label", "한 곳에서 한 번에").containsEntry("total_krw", 120400)
				.containsEntry("delivery_count", 1).containsEntry("same_as", "purchase_1")
				.containsEntry("warning_ids", List.of("VAT_UNKNOWN")).containsEntry("suppliers", List.of("카페 도매몰"));
		// 자기 자신을 가리키는 잘못된 값은 따라가지 않고 원래 안 그대로 둔다.
		assertThat(choices.get(2)).containsEntry("total_krw", null);
	}

	@Test
	void 운영은_하루_인건비와_대기_지표와_추천을_넘긴다() {
		Map<String, Object> stored = read("""
				{'choices': [
				  {'choice_key': 'CURRENT', 'cash_cost_krw': 113520, 'base_wage_krw': 113520,
				   'metrics': {'post_order_wait_mean_seconds': 521.9639, 'post_order_wait_over_300_ratio': 0.4802},
				   'staffing_summary': {'total_staff_hours': 24.0, 'assignments': []}},
				  {'choice_key': 'ALT_C', 'cash_cost_krw': 144480.0,
				   'metrics': {'post_order_wait_mean_seconds': 142.2, 'post_order_wait_over_300_ratio': 0.024}}],
				 'recommendation': {'choice_key': 'ALT_C', 'reason': 'x'},
				 'warnings': [{'warning_id': 'SIMULATED_CONDITIONS', 'message': '모의 조건', 'requires_ack': true}]}""");

		Map<String, Object> summary = ExplanationSummary.operation(stored);

		List<Map<String, Object>> choices = (List<Map<String, Object>>) summary.get("choices");
		assertThat(choices.get(0)).containsEntry("label", "현재 방식").containsEntry("total_krw", 113520L)
				.containsEntry("drink_wait_mean_minutes", new BigDecimal("8.7"))
				.containsEntry("drink_wait_over_5min_pct", new BigDecimal("48.0"))
				.containsEntry("wait_threshold_minutes", 5)
				.containsEntry("total_staff_hours", 24.0);
		// 설명 쪽 안전 규칙이 "한 명" 같은 말을 막아서 요약에는 "직원 추가"로 넘긴다.
		assertThat(choices.get(1)).containsEntry("label", "직원 추가").containsEntry("total_krw", 144480L)
				.containsEntry("drink_wait_mean_minutes", new BigDecimal("2.4"))
				.containsEntry("drink_wait_over_5min_pct", new BigDecimal("2.4"));
		assertThat(summary).containsEntry("recommended_choice_key", "ALT_C");
		assertThat((List<?>) summary.get("warnings")).hasSize(1);
	}

	@Test
	void 운영_추천이_없으면_null로_넘긴다() {
		Map<String, Object> summary = ExplanationSummary.operation(read("{'choices': [], 'recommendation': null}"));
		assertThat(summary).containsEntry("recommended_choice_key", null);
	}
}
