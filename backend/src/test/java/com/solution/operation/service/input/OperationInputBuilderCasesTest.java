package com.solution.operation.service.input;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.solution.operation.dto.input.OperationInputDraftRequest;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

/**
 * 운영 입력 완성본 기준 파일(data/demo/operation/input_builder_cases.json)과 이 빌더 결과가 같은지 본다.
 *
 * <p>같은 규칙으로 완성본을 만드는 곳이 두 군데다: 폼은 이 빌더(Spring), 대화는 ai-server
 * app/agent/operation_fields.build()(Python). 두 쪽 테스트가 같은 기준 파일을 보므로 한쪽만 바꾸면 그쪽 테스트가 실패한다.
 *
 * <p>빌더 규칙을 일부러 바꿀 때:
 * <ol>
 *   <li>이 빌더를 고친다.</li>
 *   <li>기준 파일을 새로 뽑는다: {@code UPDATE_BUILDER_CASES=1 ./gradlew test --no-daemon --tests '*OperationInputBuilderCasesTest'}</li>
 *   <li>Python operation_fields.build()를 같은 규칙으로 고치고 {@code pytest tests/test_agent_operation.py}로 확인한다.</li>
 * </ol>
 */
class OperationInputBuilderCasesTest {

	static final Path CASES = Path.of("../data/demo/operation/input_builder_cases.json");
	/** 기준 파일을 뽑은 날. 영업일을 비운 경우의 기본값이 이 날로 정해진다. */
	static final LocalDate TODAY = LocalDate.of(2026, 11, 18);

	private final ObjectMapper mapper = JsonMapper.builder().build();

	@Test
	void 기준_파일과_같은_완성본을_만든다() throws Exception {
		Map<String, Map<String, Object>> cases = mapper.readValue(Files.readString(CASES), new TypeReference<>() { });
		assertThat(cases).isNotEmpty();
		if (System.getenv("UPDATE_BUILDER_CASES") != null) {
			Map<String, Object> updated = new LinkedHashMap<>();
			cases.forEach((name, row) -> updated.put(name,
					Map.of("form", row.get("form"), "input", OperationInputBuilder.build(request(map(row.get("form"))), TODAY))));
			Files.writeString(CASES, mapper.writerWithDefaultPrettyPrinter().writeValueAsString(updated) + "\n");
			return;
		}
		cases.forEach((name, row) -> {
			JsonNode built = mapper.valueToTree(OperationInputBuilder.build(request(map(row.get("form"))), TODAY));
			assertThat(built).as(name + " 완성본이 기준 파일과 달라요. 빌더를 바꿨다면 기준 파일과 Python 빌더도 같이 고쳐 주세요.")
					.isEqualTo(mapper.valueToTree(row.get("input")));
		});
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> map(Object value) {
		return (Map<String, Object>) value;
	}

	@SuppressWarnings("unchecked")
	private static OperationInputDraftRequest request(Map<String, Object> form) {
		Object date = form.get("business_date");
		Map<String, Number> weights = (Map<String, Number>) form.get("menu_weights");
		Map<String, Double> menuWeights = null;
		if (weights != null) {
			menuWeights = new LinkedHashMap<>();
			for (var e : weights.entrySet()) {
				menuWeights.put(e.getKey(), e.getValue().doubleValue());
			}
		}
		return new OperationInputDraftRequest(date == null ? null : LocalDate.parse((String) date), integer(form.get("daily_orders")),
				(String) form.get("last_order_time"), (List<String>) form.get("selected_menu_ids"),
				(Boolean) form.get("is_owner_working"), integer(form.get("hourly_wage_krw")), (Boolean) form.get("is_staff_minor"),
				(String) form.get("rush_start_time"), (String) form.get("rush_end_time"), menuWeights,
				integer(form.get("order_time_sec")), integer(form.get("handoff_time_sec")));
	}

	private static Integer integer(Object value) {
		return value == null ? null : ((Number) value).intValue();
	}
}
