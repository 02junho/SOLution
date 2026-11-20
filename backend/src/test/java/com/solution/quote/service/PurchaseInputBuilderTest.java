package com.solution.quote.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.solution.common.exception.ApiException;

@SuppressWarnings("unchecked")
class PurchaseInputBuilderTest {

	private final ObjectMapper json = new ObjectMapper();

	private JsonNode node(String text) throws Exception {
		return json.readTree(text.replace('\'', '"'));
	}

	private final String dictionary = """
			{'version': 3, 'items': [
			  {'item_id': 'bean', 'name': '원두', 'base_unit': 'g'},
			  {'item_id': 'cup', 'name': '컵', 'base_unit': '개'}]}""";

	private final String preview = """
			{'status': 'ok', 'items': [
			  {'item_id': 'bean', 'unit': 'g', 'gross_need': 2700, 'usable_inventory': 1000, 'safety_stock': 500},
			  {'item_id': 'cup', 'unit': '개', 'gross_need': 150.0, 'usable_inventory': null, 'safety_stock': null}]}""";

	private String row(String line, String supplier, String item, String qty, String unit, String price, String vat,
			boolean comparable, String issue) {
		return ("{'line_id': '%s', 'supplier_name': %s, 'item_id': %s, 'normalized_quantity_per_pack': %s,"
				+ " 'normalized_unit': %s, 'pack_price': %s, 'vat_status': '%s', 'comparable': %s, 'issues': [%s]}")
				.formatted(line, supplier, item, qty, unit, price, vat, comparable,
						issue == null ? "" : "{'code': '" + issue + "', 'blocks_comparison': true}");
	}

	private PurchaseInputBuilder.Batch batch(String id, String delivery, String... rows) throws Exception {
		return new PurchaseInputBuilder.Batch(id, node("{'normalization': {'items': [" + String.join(",", rows)
				+ "]}, 'delivery': [" + delivery + "]}"));
	}

	private Map<String, Object> conditions(Object days, Object budget, Object deliveries) {
		Map<String, Object> map = new LinkedHashMap<>();
		map.put("planning_days", days);
		map.put("budget_krw", budget);
		map.put("max_delivery_count", deliveries);
		return map;
	}

	@Test
	void 견적_정리_결과를_구매_입력으로_묶는다() throws Exception {
		var batch = batch("b1", "{'supplier_name': 'A 식자재', 'fee_amount': 3000, 'free_shipping_minimum': 50000}",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null),
				row("quote-line-002", "'a식자재'", "'cup'", "50", "'개'", "5000", "unknown", true, null),
				// 같은 줄이 또 오면 하나만 넣는다.
				row("quote-line-003", "'A식자재'", "'bean'", "1000.0", "'g'", "18000", "included", true, null),
				row("quote-line-004", "'B마트'", "null", "null", "null", "9000", "excluded", false,
						"ITEM_CONFIRMATION_REQUIRED"));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(batch),
				conditions(7, null, 2), Map.of("preparation_id", "p1"));
		Map<String, Object> input = built.input();

		assertThat(input).containsEntry("planning_days", 7).containsEntry("budget_krw", null)
				.containsEntry("max_delivery_count", 2);
		var items = (List<Map<String, Object>>) input.get("items");
		assertThat(items).extracting("item_id", "item_name", "base_unit", "gross_need")
				.containsExactly(org.assertj.core.groups.Tuple.tuple("bean", "원두", "g", 2700L),
						org.assertj.core.groups.Tuple.tuple("cup", "컵", "ea", 150L));
		assertThat(items.get(1)).containsEntry("usable_inventory", null).containsEntry("storage_capacity", null);

		var suppliers = (List<Map<String, Object>>) input.get("suppliers");
		assertThat(suppliers).hasSize(1);
		assertThat(suppliers.get(0)).containsEntry("supplier_id", "a식자재").containsEntry("supplier_name", "A식자재")
				.containsEntry("minimum_order_krw", null).containsEntry("delivery_fee_krw", 3000L)
				.containsEntry("free_delivery_min_krw", 50000L);

		var quotes = (List<Map<String, Object>>) input.get("quotes");
		assertThat(quotes).extracting("item_id", "pack_size", "pack_unit", "pack_price_krw", "vat_included")
				.containsExactly(org.assertj.core.groups.Tuple.tuple("bean", 1000L, "g", 18000L, true),
						org.assertj.core.groups.Tuple.tuple("cup", 50L, "ea", 5000L, null));

		assertThat(built.excludedLines()).containsExactly(
				Map.of("line_id", "b1:quote-line-004", "reason", "ITEM_CONFIRMATION_REQUIRED"));
		var source = (Map<String, Object>) input.get("source");
		assertThat(source).containsEntry("preparation_id", "p1").containsEntry("dictionary_version", 3L);
	}

	@Test
	void 배송_줄에_거래처가_없으면_묶음의_유일한_거래처에_붙인다() throws Exception {
		var batch = batch("b1", "{'supplier_name': null, 'fee_amount': 2500, 'free_shipping_minimum': null}",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null),
				row("quote-line-002", "'A식자재'", "'cup'", "50", "'개'", "5000", "included", true, null));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(batch),
				conditions(null, null, null), Map.of());

		var supplier = ((List<Map<String, Object>>) built.input().get("suppliers")).get(0);
		assertThat(supplier).containsEntry("delivery_fee_krw", 2500L).containsEntry("free_delivery_min_krw", null);
	}

	@Test
	void 뺀_줄의_거래처가_있으면_거래처_없는_배송_줄을_아무에게도_붙이지_않는다() throws Exception {
		// B마트 줄은 빠지지만 같은 배치의 거래처는 둘이다. 배송비가 누구 것인지 모르므로 질문으로 넘긴다.
		var batch = batch("b1", "{'supplier_name': null, 'fee_amount': 2500, 'free_shipping_minimum': null}",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null),
				row("quote-line-002", "'A식자재'", "'cup'", "50", "'개'", "5000", "included", true, null),
				row("quote-line-003", "'B마트'", "null", "null", "null", "9000", "excluded", false,
						"ITEM_CONFIRMATION_REQUIRED"));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(batch),
				conditions(null, null, null), Map.of());

		var supplier = ((List<Map<String, Object>>) built.input().get("suppliers")).get(0);
		assertThat(supplier).containsEntry("supplier_name", "A식자재").containsEntry("delivery_fee_krw", null);
	}

	@Test
	void 배치마다_배송_조건이_다르면_섞지_않고_뒤_배치_묶음을_쓰고_기록한다() throws Exception {
		var first = batch("b1", "{'supplier_name': 'A식자재', 'fee_amount': 3000, 'free_shipping_minimum': null}",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null));
		var second = batch("b2", "{'supplier_name': 'A식자재', 'fee_amount': 5000, 'free_shipping_minimum': 50000}",
				row("quote-line-001", "'A식자재'", "'cup'", "50", "'개'", "5000", "included", true, null));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(first, second),
				conditions(null, null, null), Map.of());

		var supplier = ((List<Map<String, Object>>) built.input().get("suppliers")).get(0);
		assertThat(supplier).containsEntry("delivery_fee_krw", 5000L).containsEntry("free_delivery_min_krw", 50000L);
		var conflicts = (List<Map<String, Object>>) ((Map<String, Object>) built.input().get("source"))
				.get("delivery_conflicts");
		assertThat(conflicts).singleElement().satisfies(conflict -> assertThat(conflict)
				.containsEntry("replaced_batch_id", "b1").containsEntry("used_batch_id", "b2")
				.containsEntry("replaced", java.util.Arrays.asList(3000L, null, null)));
	}

	@Test
	void 견적에_적힌_최소_주문_금액은_붙이고_없으면_비워_둔다() throws Exception {
		// 거래처마다 견적을 따로 분석해 배치가 여러 개여도 최소 주문 금액은 그 거래처에 붙는다.
		var first = batch("b1", "{'supplier_name': 'A식자재', 'fee_amount': 2900, 'free_shipping_minimum': 78800,"
				+ " 'minimum_order_amount': 76000}",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null));
		var second = batch("b2", "{'supplier_name': 'B마트', 'fee_amount': 0, 'free_shipping_minimum': null,"
				+ " 'minimum_order_amount': 0}",
				row("quote-line-001", "'B마트'", "'cup'", "50", "'개'", "5000", "included", true, null));
		var third = batch("b3", "{'supplier_name': 'C몰', 'fee_amount': 3000, 'free_shipping_minimum': null}",
				row("quote-line-001", "'C몰'", "'cup'", "100", "'개'", "9000", "included", true, null));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(first, second, third),
				conditions(null, null, null), Map.of());

		var suppliers = (List<Map<String, Object>>) built.input().get("suppliers");
		assertThat(suppliers).extracting("supplier_name", "minimum_order_krw", "delivery_fee_krw")
				.containsExactly(org.assertj.core.groups.Tuple.tuple("A식자재", 76000L, 2900L),
						org.assertj.core.groups.Tuple.tuple("B마트", 0L, 0L),
						org.assertj.core.groups.Tuple.tuple("C몰", null, 3000L));
	}

	@Test
	void 앞_배치의_배송비는_그_거래처_견적이_뒤_배치에만_있어도_살린다() throws Exception {
		// b1의 A식자재 줄은 필요 없는 품목이라 빠지고, A식자재의 쓸 견적은 b2에만 있다.
		var first = batch("b1", "{'supplier_name': 'A식자재', 'fee_amount': 3000, 'free_shipping_minimum': null}",
				row("quote-line-001", "'A식자재'", "'milk'", "1000", "'ml'", "2500", "included", true, null));
		var second = batch("b2", "",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null),
				row("quote-line-002", "'A식자재'", "'cup'", "50", "'개'", "5000", "included", true, null));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(first, second),
				conditions(null, null, null), Map.of());

		var supplier = ((List<Map<String, Object>>) built.input().get("suppliers")).get(0);
		assertThat(supplier).containsEntry("delivery_fee_krw", 3000L);
	}

	@Test
	void 같은_배치_안에서는_배송비와_무료배송_기준이_다른_줄에_있어도_합친다() throws Exception {
		var batch = batch("b1", "{'supplier_name': 'A식자재', 'fee_amount': 3000, 'free_shipping_minimum': null},"
				+ "{'supplier_name': 'A식자재', 'fee_amount': null, 'free_shipping_minimum': 50000}",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null),
				row("quote-line-002", "'A식자재'", "'cup'", "50", "'개'", "5000", "included", true, null));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(batch),
				conditions(null, null, null), Map.of());

		var supplier = ((List<Map<String, Object>>) built.input().get("suppliers")).get(0);
		assertThat(supplier).containsEntry("delivery_fee_krw", 3000L).containsEntry("free_delivery_min_krw", 50000L);
	}

	@Test
	void 필요없는_품목이나_단위가_다른_견적은_빼고_이유를_남긴다() throws Exception {
		var batch = batch("b1", "",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null),
				row("quote-line-002", "'A식자재'", "'cup'", "50", "'개'", "5000", "included", true, null),
				row("quote-line-003", "'A식자재'", "'milk'", "1000", "'ml'", "2500", "included", true, null),
				row("quote-line-004", "'A식자재'", "'cup'", "50", "'g'", "5000", "included", true, null));

		var built = PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(batch),
				conditions(null, null, null), Map.of());

		assertThat(built.excludedLines()).containsExactly(
				Map.of("line_id", "b1:quote-line-003", "reason", "ITEM_NOT_NEEDED"),
				Map.of("line_id", "b1:quote-line-004", "reason", "UNIT_MISMATCH"));
	}

	@Test
	void 필요한_품목에_쓸_견적이_하나도_없으면_400() throws Exception {
		var batch = batch("b1", "",
				row("quote-line-001", "'A식자재'", "'bean'", "1000", "'g'", "18000", "included", true, null));

		assertThatThrownBy(() -> PurchaseInputBuilder.build(node(preview), node(dictionary), List.of(batch),
				conditions(null, null, null), Map.of()))
				.isInstanceOf(ApiException.class)
				.hasMessageContaining("견적이 없는 품목이 있어요: 컵");
	}

	@Test
	void 단위와_부가세_표기를_구매_쪽_형식으로_바꾼다() {
		assertThat(PurchaseInputBuilder.unit("개")).isEqualTo("ea");
		assertThat(PurchaseInputBuilder.unit("ml")).isEqualTo("ml");
		assertThat(PurchaseInputBuilder.vat("included")).isEqualTo(true);
		assertThat(PurchaseInputBuilder.vat("excluded")).isEqualTo(false);
		assertThat(PurchaseInputBuilder.vat("unknown")).isNull();
		assertThat(PurchaseInputBuilder.supplierId(" Ａ 식자재 ")).isEqualTo("a식자재");
	}
}
