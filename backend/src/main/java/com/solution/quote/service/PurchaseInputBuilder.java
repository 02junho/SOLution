package com.solution.quote.service;

import java.math.BigDecimal;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import com.fasterxml.jackson.databind.JsonNode;
import com.solution.common.exception.ApiException;

/**
 * 견적 정리 결과(필요량 미리보기·품목 사전·견적 배치)를 구매 최적화 입력(purchase.v1) 한 덩어리로 묶는다.
 * 작성: 신준호 (구매 최적화)
 *
 * <p>값을 지어내지 않는다. 견적에 없는 기간·예산·배송 횟수·최소 주문 금액은 null로 두고,
 * 업무 입력 저장 단계(collectUnknown)가 사장님께 질문하게 한다. 재고 차감과 팩 단위 올림은 최적화가 맡는다.
 * 비교할 수 없는 견적 줄은 빼고 excluded_lines에 이유를 남긴다. 필요한 품목에 쓸 견적이 하나도 없으면 400.
 */
public final class PurchaseInputBuilder {

	private PurchaseInputBuilder() {
	}

	public record Built(Map<String, Object> input, List<Map<String, Object>> excludedLines) {
	}

	public record Batch(String batchId, JsonNode payload) {
	}

	public static Built build(JsonNode preview, JsonNode dictionary, List<Batch> batches,
			Map<String, Object> conditions, Map<String, Object> source) {
		Map<String, String> names = new LinkedHashMap<>();
		for (JsonNode item : dictionary.path("items")) {
			names.put(item.path("item_id").asText(), item.path("name").asText());
		}

		// 품목: 미리보기의 총 필요량과 재고를 그대로 쓴다.
		List<Map<String, Object>> items = new ArrayList<>();
		Map<String, String> units = new LinkedHashMap<>();
		for (JsonNode row : preview.path("items")) {
			String itemId = row.path("item_id").asText();
			String unit = unit(row.path("unit").asText());
			units.put(itemId, unit);
			Map<String, Object> item = new LinkedHashMap<>();
			item.put("item_id", itemId);
			item.put("item_name", names.getOrDefault(itemId, itemId));
			item.put("base_unit", unit);
			item.put("gross_need", number(row.get("gross_need")));
			item.put("usable_inventory", number(row.get("usable_inventory")));
			item.put("safety_stock", number(row.get("safety_stock")));
			item.put("storage_capacity", null);
			item.put("max_end_inventory", null);
			items.add(item);
		}
		if (items.isEmpty()) {
			throw ApiException.badRequest("필요량이 계산된 품목이 없어요. 판매 계획과 재료표를 먼저 확인해 주세요.");
		}

		// 견적: 비교 가능한 줄만 넣고, 나머지는 이유와 함께 남긴다.
		Map<String, Map<String, Object>> suppliers = new LinkedHashMap<>();
		List<Map<String, Object>> quotes = new ArrayList<>();
		Set<List<Object>> seen = new LinkedHashSet<>();
		List<Map<String, Object>> excluded = new ArrayList<>();
		Map<String, String> deliveryBatch = new LinkedHashMap<>();
		List<Map<String, Object>> deliveryConflicts = new ArrayList<>();
		for (Batch batch : batches) {
			// 거래처 없는 배송 줄의 주인을 정할 때는 뺀 줄까지 포함한 배치 전체의 거래처를 본다.
			Set<String> batchSuppliers = new LinkedHashSet<>();
			for (JsonNode row : batch.payload().path("normalization").path("items")) {
				if (!row.path("supplier_name").asText("").isBlank()) {
					batchSuppliers.add(supplierId(row.path("supplier_name").asText()));
				}
			}
			for (JsonNode row : batch.payload().path("normalization").path("items")) {
				String lineId = batch.batchId() + ":" + row.path("line_id").asText();
				String itemId = row.path("item_id").isTextual() ? row.path("item_id").asText() : null;
				String reason = null;
				if (!row.path("comparable").asBoolean(false) || itemId == null) {
					reason = firstBlockingIssue(row);
				}
				else if (!units.containsKey(itemId)) {
					reason = "ITEM_NOT_NEEDED";
				}
				else if (!units.get(itemId).equals(unit(row.path("normalized_unit").asText()))) {
					reason = "UNIT_MISMATCH";
				}
				Object packSize = number(row.get("normalized_quantity_per_pack"));
				Long packPrice = integer(row.get("pack_price"));
				if (reason == null && (!(packSize instanceof Number size) || decimal(size).signum() <= 0)) {
					reason = "INVALID_OR_MISSING_UNIT_QUANTITY";
				}
				if (reason == null && packPrice == null) {
					reason = "INVALID_OR_MISSING_PRICE";
				}
				if (reason != null) {
					excluded.add(Map.of("line_id", lineId, "reason", reason));
					continue;
				}
				String supplierName = row.path("supplier_name").asText().trim();
				String supplierId = supplierId(supplierName);
				suppliers.computeIfAbsent(supplierId, id -> supplier(id, supplierName));
				Object vat = vat(row.path("vat_status").asText());
				if (!seen.add(java.util.Arrays.asList(supplierId, itemId, decimal((Number) packSize), packPrice, vat))) {
					continue;
				}
				Map<String, Object> quote = new LinkedHashMap<>();
				quote.put("supplier_id", supplierId);
				quote.put("item_id", itemId);
				quote.put("pack_size", packSize);
				quote.put("pack_unit", units.get(itemId));
				quote.put("pack_price_krw", packPrice);
				quote.put("vat_included", vat);
				quotes.add(quote);
			}
			applyDelivery(batch, batchSuppliers, suppliers, deliveryBatch, deliveryConflicts);
		}

		List<String> missing = new ArrayList<>();
		for (Map<String, Object> item : items) {
			if (quotes.stream().noneMatch(quote -> quote.get("item_id").equals(item.get("item_id")))) {
				missing.add(String.valueOf(item.get("item_name")));
			}
		}
		if (!missing.isEmpty()) {
			throw ApiException.badRequest("NO_QUOTE_FOR_ITEM",
					"견적이 없는 품목이 있어요: " + String.join(", ", missing) + ". 견적을 더 넣거나 확인해 주세요.");
		}

		Map<String, Object> input = new LinkedHashMap<>();
		input.put("planning_days", conditions.get("planning_days"));
		input.put("budget_krw", conditions.get("budget_krw"));
		input.put("max_delivery_count", conditions.get("max_delivery_count"));
		input.put("items", items);
		input.put("suppliers", new ArrayList<>(suppliers.values()));
		input.put("quotes", quotes);
		Map<String, Object> trace = new LinkedHashMap<>(source);
		trace.put("dictionary_version", number(dictionary.get("version")));
		trace.put("excluded_lines", excluded);
		trace.put("delivery_conflicts", deliveryConflicts);
		input.put("source", trace);
		return new Built(input, excluded);
	}

	/** 견적 쪽은 "개", 구매 쪽은 "ea"를 쓴다. 동결 뒤 하나로 맞추기 전까지 여기서만 바꾼다. */
	static String unit(String unit) {
		return "개".equals(unit) ? "ea" : unit;
	}

	static Object vat(String status) {
		return switch (status) {
			case "included" -> Boolean.TRUE;
			case "excluded" -> Boolean.FALSE;
			default -> null;
		};
	}

	/** 같은 거래처를 같은 ID로 묶는다. 대소문자·전각·공백 차이는 무시한다. */
	static String supplierId(String name) {
		return Normalizer.normalize(name, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT).replaceAll("\\s+", "");
	}

	private static Map<String, Object> supplier(String id, String name) {
		Map<String, Object> supplier = new LinkedHashMap<>();
		supplier.put("supplier_id", id);
		supplier.put("supplier_name", name);
		// 견적 문자에는 최소 주문 금액이 거의 없다. 0으로 채우지 않고 사장님께 묻는다.
		supplier.put("minimum_order_krw", null);
		supplier.put("delivery_fee_krw", null);
		supplier.put("free_delivery_min_krw", null);
		return supplier;
	}

	/**
	 * 배송 조건(배송비·무료배송 기준)은 배치 하나에서 한 묶음으로 가져온다. 같은 배치 안의 여러 줄은 합치지만,
	 * 서로 다른 배치의 값을 섞지 않는다. 같은 거래처의 조건이 배치마다 다르면 요청 순서상 뒤 배치(최근 견적)의
	 * 묶음 전체를 쓰고, 바뀐 내용을 delivery_conflicts에 남긴다.
	 */
	private static void applyDelivery(Batch batch, Set<String> batchSuppliers,
			Map<String, Map<String, Object>> suppliers, Map<String, String> deliveryBatch,
			List<Map<String, Object>> conflicts) {
		Map<String, Long[]> pairs = new LinkedHashMap<>();
		for (JsonNode row : batch.payload().path("delivery")) {
			String name = row.path("supplier_name").asText("");
			// 거래처가 안 적힌 배송 줄은 배치 전체의 거래처가 하나일 때만 그 거래처 것으로 본다.
			String id = !name.isBlank() ? supplierId(name)
					: batchSuppliers.size() == 1 ? batchSuppliers.iterator().next() : null;
			if (id == null || !suppliers.containsKey(id)) {
				continue;
			}
			Long[] pair = pairs.computeIfAbsent(id, key -> new Long[2]);
			if (pair[0] == null) {
				pair[0] = integer(row.get("fee_amount"));
			}
			if (pair[1] == null) {
				pair[1] = integer(row.get("free_shipping_minimum"));
			}
		}
		pairs.forEach((id, pair) -> {
			if (pair[0] == null && pair[1] == null) {
				return;
			}
			Map<String, Object> supplier = suppliers.get(id);
			Object fee = supplier.get("delivery_fee_krw");
			Object free = supplier.get("free_delivery_min_krw");
			if (deliveryBatch.containsKey(id) && !(java.util.Objects.equals(fee, pair[0])
					&& java.util.Objects.equals(free, pair[1]))) {
				Map<String, Object> conflict = new LinkedHashMap<>();
				conflict.put("supplier_id", id);
				conflict.put("replaced_batch_id", deliveryBatch.get(id));
				conflict.put("replaced", java.util.Arrays.asList(fee, free));
				conflict.put("used_batch_id", batch.batchId());
				conflicts.add(conflict);
			}
			supplier.put("delivery_fee_krw", pair[0]);
			supplier.put("free_delivery_min_krw", pair[1]);
			deliveryBatch.put(id, batch.batchId());
		});
	}

	private static String firstBlockingIssue(JsonNode row) {
		for (JsonNode issue : row.path("issues")) {
			if (issue.path("blocks_comparison").asBoolean(false)) {
				return issue.path("code").asText();
			}
		}
		return row.path("item_id").isTextual() ? "NOT_COMPARABLE" : "ITEM_CONFIRMATION_REQUIRED";
	}

	/** 숫자는 정수면 Long, 아니면 BigDecimal로 둔다. FastAPI가 Decimal을 문자열로 보낸 경우도 읽는다. */
	private static Object number(JsonNode node) {
		if (node == null || node.isNull() || node.isMissingNode()) {
			return null;
		}
		BigDecimal value;
		if (node.isNumber()) {
			value = node.decimalValue();
		}
		else if (node.isTextual()) {
			try {
				value = new BigDecimal(node.asText().trim());
			}
			catch (NumberFormatException e) {
				return null;
			}
		}
		else {
			return null;
		}
		BigDecimal plain = value.stripTrailingZeros();
		if (plain.scale() <= 0) {
			try {
				return plain.longValueExact();
			}
			catch (ArithmeticException e) {
				return plain;
			}
		}
		return plain;
	}

	private static Long integer(JsonNode node) {
		return number(node) instanceof Long value && value >= 0 ? value : null;
	}

	private static BigDecimal decimal(Number number) {
		return new BigDecimal(number.toString()).stripTrailingZeros();
	}
}
