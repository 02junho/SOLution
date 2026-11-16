package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.Base64;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import tools.jackson.databind.ObjectMapper;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {"demo.owner-key=demo-owner", "demo.seed=false"})
@AutoConfigureMockMvc
@Testcontainers
class WorkConfirmationListApiIntegrationTest {

	@Container @ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired private MockMvc mvc;
	@Autowired private JdbcTemplate jdbc;
	@Autowired private ObjectMapper json;
	@LocalServerPort private int port;

	@BeforeEach
	void seed() {
		for (String table : new String[]{"execution_log", "session_message", "work_confirmation", "work_result", "work_version", "work_session", "store"}) {
			jdbc.update("DELETE FROM " + table);
		}
		jdbc.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time)
				VALUES (10, 'demo-owner', '내 매장', '07:00', '19:00'), (20, 'other', '남의 매장', '07:00', '19:00')
				""");
		jdbc.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version, step)
				VALUES (500, 10, 'purchase', 'form', '매입 업무', 2, 'saved'),
				       (600, 20, 'purchase', 'form', '남의 업무', 1, 'saved'),
				       (700, 10, 'operation', 'form', '운영 업무', 1, 'saved')
				""");
		insert(3001, 2001, 1001, 500, 10, 1, "purchase", "2026-11-13T10:00:00.000001Z");
		insert(3002, 2002, 1002, 500, 10, 2, "purchase", "2026-11-13T11:00:00.000001Z");
		insert(3003, 2003, 1003, 700, 10, 1, "operation", "2026-11-13T11:00:00.000001Z");
		insert(9999, 2999, 1999, 600, 20, 1, "purchase", "2026-11-13T12:00:00Z");
	}

	@Test
	void 실제_HTTP로_내_확정만_최신순으로_읽고_데이터를_수정하지_않는다() throws Exception {
		var before = jdbc.queryForList("SELECT * FROM work_confirmation ORDER BY confirmation_id");
		var sessions = jdbc.queryForList("SELECT * FROM work_session ORDER BY session_id");
		try (HttpClient client = HttpClient.newHttpClient()) {
			var response = client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port
					+ "/api/v1/work-confirmations")).GET().build(), HttpResponse.BodyHandlers.ofString());
			assertThat(response.statusCode()).isEqualTo(200);
			var data = json.readTree(response.body()).get("data");
			assertThat(data.get("items").size()).isEqualTo(3);
			assertThat(data.get("items").get(0).get("confirmation_id").asLong()).isEqualTo(3003);
			assertThat(data.get("items").get(1).get("confirmation_id").asLong()).isEqualTo(3002);
			assertThat(data.get("items").get(2).get("is_current_version").asBoolean()).isFalse();
			assertThat(data.get("next_cursor").isNull()).isTrue();
		}
		assertThat(jdbc.queryForList("SELECT * FROM work_confirmation ORDER BY confirmation_id")).isEqualTo(before);
		assertThat(jdbc.queryForList("SELECT * FROM work_session ORDER BY session_id")).isEqualTo(sessions);
	}

	@Test
	void 동시간_확정도_커서로_누락_중복_없이_읽는다() throws Exception {
		String response = mvc.perform(get("/api/v1/work-confirmations").param("size", "1"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items[0].confirmation_id").value(3003))
				.andReturn().getResponse().getContentAsString();
		String cursor = json.readTree(response).get("data").get("next_cursor").asText();
		response = mvc.perform(get("/api/v1/work-confirmations").param("size", "1").param("cursor", cursor))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items[0].confirmation_id").value(3002))
				.andReturn().getResponse().getContentAsString();
		cursor = json.readTree(response).get("data").get("next_cursor").asText();
		mvc.perform(get("/api/v1/work-confirmations").param("size", "1").param("cursor", cursor))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items[0].confirmation_id").value(3001))
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
	}

	@Test
	void 기능과_업무_필터를_함께_적용한다() throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("feature_type", "purchase").param("session_id", "500"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(2))
				.andExpect(jsonPath("$.data.items[0].selected_choice_key").value("purchase_1"))
				.andExpect(jsonPath("$.data.items[0].version_no").value(2))
				.andExpect(jsonPath("$.data.items[0].is_current_version").value(true))
				.andExpect(jsonPath("$.data.items[1].is_current_version").value(false))
				.andExpect(jsonPath("$.message").value(nullValue()));
		mvc.perform(get("/api/v1/work-confirmations").param("feature_type", "operation"))
				.andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].selected_choice_key").value("CURRENT"));
	}

	@ParameterizedTest @ValueSource(strings = {"600", "999999"})
	void 남의_업무와_없는_업무_필터는_동일하게_빈_목록(String session) throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("session_id", session))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items").isEmpty())
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
	}

	@Test
	void 복제_매장_업무_기능_버전이_틀려도_실제_소속으로_권한과_최신성을_판정한다() throws Exception {
		jdbc.update("UPDATE work_confirmation SET store_id=20, session_id=600, feature_type='operation', version_no=2 WHERE confirmation_id=3001");
		jdbc.update("UPDATE work_confirmation SET store_id=10, session_id=500, feature_type='purchase', version_no=2 WHERE confirmation_id=9999");
		mvc.perform(get("/api/v1/work-confirmations").param("feature_type", "purchase").param("session_id", "500"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(2))
				.andExpect(jsonPath("$.data.items[1].confirmation_id").value(3001))
				.andExpect(jsonPath("$.data.items[1].session_id").value(500))
				.andExpect(jsonPath("$.data.items[1].feature_type").value("purchase"))
				.andExpect(jsonPath("$.data.items[1].version_no").value(1))
				.andExpect(jsonPath("$.data.items[1].is_current_version").value(false));
	}

	@Test
	void 새_입력이_생기면_과거_확정의_현재유효성만_바뀐다() throws Exception {
		jdbc.update("UPDATE work_session SET current_version=3 WHERE session_id=500");
		mvc.perform(get("/api/v1/work-confirmations").param("session_id", "500"))
				.andExpect(jsonPath("$.data.items[0].is_current_version").value(false))
				.andExpect(jsonPath("$.data.items[1].is_current_version").value(false));
	}

	@Test
	void 빈_이력과_끝_커서는_빈_목록이다() throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("cursor", cursor("2020-01-01T00:00:00Z,1")))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items").isEmpty());
		jdbc.update("DELETE FROM work_confirmation");
		mvc.perform(get("/api/v1/work-confirmations"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items").isEmpty())
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
	}

	@Test
	void 기본20_비양수기본값_최대100은_업무목록과_동일하다() throws Exception {
		jdbc.update("DELETE FROM work_confirmation");
		jdbc.update("DELETE FROM work_result");
		jdbc.update("DELETE FROM work_version");
		jdbc.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json)
				SELECT 10000+n, 500, n, 'v1', '{}' FROM generate_series(1,105) n
				""");
		jdbc.update("""
				INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no,
				    feature_type, request_key, response_status, summary_json)
				SELECT 20000+n, 10000+n, 500, 10, n, 'purchase', 'result-' || n, 'ok', '{}' FROM generate_series(1,105) n
				""");
		jdbc.update("""
				INSERT INTO work_confirmation (confirmation_id, result_id, input_version_id, session_id, store_id,
				    version_no, feature_type, selected_choice_key, confirmed_by, confirm_request_key,
				    request_fingerprint, selected_snapshot_json)
				SELECT 30000+n, 20000+n, 10000+n, 500, 10, n, 'purchase', 'purchase_1', 'demo-owner',
				    'confirmation-' || n, repeat('a',64), '{}' FROM generate_series(1,105) n
				""");
		mvc.perform(get("/api/v1/work-confirmations")).andExpect(jsonPath("$.data.items.length()").value(20));
		for (String size : new String[]{"0", "-1"}) {
			mvc.perform(get("/api/v1/work-confirmations").param("size", size)).andExpect(jsonPath("$.data.items.length()").value(20));
		}
		mvc.perform(get("/api/v1/work-confirmations").param("size", "1000"))
				.andExpect(jsonPath("$.data.items.length()").value(100));
	}

	@ParameterizedTest @ValueSource(strings = {"garbage!", "invalid-time,1", "2026-11-13T10:00:00Z,0", "2026-11-13T10:00:00Z,-1", "2026-11-13T10:00:00Z,9223372036854775808", "missing-comma"})
	void 잘못된_커서는_400(String raw) throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("cursor", cursor(raw))).andExpect(status().isBadRequest());
		mvc.perform(get("/api/v1/work-confirmations").param("cursor", "%%%" )).andExpect(status().isBadRequest());
	}

	@ParameterizedTest @ValueSource(strings = {"abc", "1.5", "2147483648"})
	void 잘못된_size_형식은_400(String size) throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("size", size)).andExpect(status().isBadRequest());
	}

	@ParameterizedTest @ValueSource(strings = {"abc", "0", "-1", "1.5", "9223372036854775808"})
	void 잘못된_session_필터는_400(String session) throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("session_id", session)).andExpect(status().isBadRequest());
	}

	@Test
	void 잘못된_기능필터는_400() throws Exception {
		mvc.perform(get("/api/v1/work-confirmations").param("feature_type", "purchase' OR '1'='1")).andExpect(status().isBadRequest());
	}

	@Test
	void 확정_API로_저장한_결과를_목록에서_조회한다() throws Exception {
		jdbc.update("DELETE FROM work_confirmation WHERE confirmation_id=3002");
		mvc.perform(post("/api/v1/work-results/2002/confirm").header("Idempotency-Key", "list-integration")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expected_input_version_id\":1002,\"selected_choice_key\":\"purchase_1\"}"))
				.andExpect(status().isOk());
		mvc.perform(get("/api/v1/work-confirmations").param("session_id", "500"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(2))
				.andExpect(jsonPath("$.data.items[0].is_current_version").value(true));
	}

	private void insert(long confirmation, long result, long version, long session, long store, int no, String feature, String at) {
		jdbc.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json, input_confirmed_by, input_confirmed_at)
				VALUES (?, ?, ?, 'v1', '{}', 'demo-owner', now())
				""", version, session, no);
		jdbc.update("""
				INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no, feature_type, request_key, response_status, summary_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', '{"choices":[{"choice_key":"purchase_1","total_krw":120400}],"warnings":[]}')
				""", result, version, session, store, no, feature, "result-" + result);
		jdbc.update("""
				INSERT INTO work_confirmation (confirmation_id, result_id, input_version_id, session_id, store_id,
				    version_no, feature_type, selected_choice_key, confirmed_by, confirmed_at, confirm_request_key,
				    request_fingerprint, selected_snapshot_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo-owner', ?, ?, ?, '{}')
				""", confirmation, result, version, session, store, no, feature,
				"operation".equals(feature) ? "CURRENT" : "purchase_1", java.time.OffsetDateTime.parse(at),
				"confirm-" + confirmation, "a".repeat(64));
	}

	private String cursor(String raw) {
		return Base64.getUrlEncoder().withoutPadding().encodeToString(raw.getBytes(StandardCharsets.UTF_8));
	}
}
