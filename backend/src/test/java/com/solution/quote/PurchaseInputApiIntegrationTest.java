package com.solution.quote;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.UUID;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.solution.quote.client.QuoteToolsClient;

/**
 * "이 견적으로 구매안 만들기" 통합 테스트. 작성: 신준호 (구매 최적화)
 *
 * <p>실제 DB에 견적 자료를 넣고, FastAPI 필요량 계산만 가짜로 둔다. 업무 생성과 첫 입력 저장이
 * 한 트랜잭션이라 저장 검증에서 거절되면 업무가 남지 않는지 확인한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "demo.owner-key=demo-owner")
@AutoConfigureMockMvc
@Testcontainers
class PurchaseInputApiIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	private static final String QUOTE_STORE = "quote-test-it";
	private static final UUID PREPARATION = UUID.fromString("11111111-2222-3333-4444-555555555555");
	private static final String BATCH = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@MockitoBean
	private QuoteToolsClient tools;

	private final ObjectMapper json = new ObjectMapper();

	private void resource(String key, String payload) {
		jdbcTemplate.update("""
				INSERT INTO quote_demo_resource (store_id, resource_key, version, payload)
				VALUES (?, ?, 1, CAST(? AS jsonb))
				""", QUOTE_STORE, key, payload.replace('\'', '"'));
	}

	@BeforeEach
	void seed() throws Exception {
		jdbcTemplate.update("DELETE FROM session_message");
		jdbcTemplate.update("DELETE FROM work_confirmation");
		jdbcTemplate.update("DELETE FROM work_result");
		jdbcTemplate.update("DELETE FROM work_version");
		jdbcTemplate.update("DELETE FROM work_session");
		jdbcTemplate.update("DELETE FROM store");
		jdbcTemplate.update("DELETE FROM quote_demo_resource");
		jdbcTemplate.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time,
				                   settings_version, profile_json, created_at, updated_at)
				VALUES (10, 'demo-owner', '데모 카페', '07:00:00', '19:00:00', 1, '{}'::jsonb, now(), now())
				""");
		resource("items", "{'version': 1, 'items': [{'item_id': 'bean', 'name': '원두', 'base_unit': 'g'}]}");
		resource("recipes", "{'recipes': {'americano': [{'item_id': 'bean', 'unit': 'g', 'amount_per_cup': 18}]}}");
		resource("inventory", "{'inventory': {'bean': {'unit': 'g', 'usable_inventory': 1000, 'safety_stock': 500}}}");
		resource("sales:" + PREPARATION, "{'sales_plan': [{'menu_id': 'americano', 'cups': 150}]}");
		resource("quotes:" + PREPARATION + ":" + BATCH, """
				{'quote_batch_id': '%s', 'normalization': {'items': [
				  {'line_id': 'quote-line-001', 'supplier_name': 'A식자재', 'item_id': 'bean',
				   'normalized_quantity_per_pack': 1000, 'normalized_unit': 'g', 'pack_price': 18000,
				   'vat_status': 'included', 'comparable': true, 'issues': []}]},
				 'delivery': [{'supplier_name': 'A식자재', 'fee_amount': 3000, 'free_shipping_minimum': null}],
				 'confirmations': {}}""".formatted(BATCH));
		given(tools.call(eq("requirements"), any())).willReturn(json.readTree(
				"{\"status\": \"ok\", \"items\": [{\"item_id\": \"bean\", \"unit\": \"g\", \"gross_need\": 2700}]}"));
	}

	private String url() {
		return "/api/v1/stores/" + QUOTE_STORE + "/purchase-preparations/" + PREPARATION + "/purchase-input";
	}

	private int count(String table) {
		return jdbcTemplate.queryForObject("SELECT count(*) FROM " + table, Integer.class);
	}

	@Test
	void 조건이_비어_있으면_업무를_만들고_빈_값을_질문으로_돌려준다() throws Exception {
		mockMvc.perform(post(url()).contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"quote_batch_ids\": [\"" + BATCH + "\"]}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("needs_input"))
				.andExpect(jsonPath("$.data.session_id").isNumber())
				.andExpect(jsonPath("$.data.draft_input.suppliers[0].delivery_fee_krw").value(3000))
				.andExpect(jsonPath("$.data.missing_fields[?(@.path == 'suppliers[0].minimum_order_krw')]").exists());

		assertThat(count("work_session")).isEqualTo(1);
		assertThat(count("work_version")).isZero();
	}

	@Test
	void 저장_검증에서_거절되면_업무도_남지_않는다() throws Exception {
		mockMvc.perform(post(url()).contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"quote_batch_ids\": [\"" + BATCH + "\"],"
						+ " \"conditions\": {\"planning_days\": -1}}"))
				.andExpect(status().isBadRequest());

		assertThat(count("work_session")).isZero();
		assertThat(count("session_message")).isZero();
	}
}
