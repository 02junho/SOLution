package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.delete;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

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
class WorkConfirmationDetailApiIntegrationTest {

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
				VALUES (500, 10, 'purchase', 'form', '확정 상세', 2, 'saved'),
				       (600, 20, 'purchase', 'form', '다른 매장', 1, 'saved'),
				       (700, 10, 'operation', 'form', '운영 확정', 1, 'saved')
				""");
		insert(3001, 2001, 1001, 500, 10, 1, "purchase");
		insert(3002, 2002, 1002, 500, 10, 2, "purchase");
		insert(3999, 2999, 1999, 600, 20, 1, "purchase");
		insert(3003, 2003, 1003, 700, 10, 1, "operation");
	}

	@Test
	void 실제_HTTP는_저장한_중첩_JSON과_메타데이터를_그대로_반환한다() throws Exception {
		try (HttpClient client = HttpClient.newHttpClient()) {
			var response = client.send(HttpRequest.newBuilder(URI.create(
					"http://localhost:" + port + "/api/v1/work-confirmations/3002")).GET().build(),
					HttpResponse.BodyHandlers.ofString());
			assertThat(response.statusCode()).isEqualTo(200);
			var root = json.readTree(response.body());
			assertThat(root.get("status").asText()).isEqualTo("ok");
			assertThat(root.get("message").isNull()).isTrue();
			var data = root.get("data");
			assertThat(data.get("selected_snapshot_json")).isEqualTo(json.readTree(jdbc.queryForObject(
					"SELECT selected_snapshot_json::text FROM work_confirmation WHERE confirmation_id=3002", String.class)));
			assertThat(data.get("acknowledged_warnings_json")).isEqualTo(json.readTree("[\"VAT_UNKNOWN\"]"));
			assertThat(data.get("is_current_version").asBoolean()).isTrue();
			assertThat(data.get("confirmed_by").asText()).isEqualTo("demo-owner");
			assertThat(data.get("result_id").asLong()).isEqualTo(2002);
			assertThat(data.get("input_version_id").asLong()).isEqualTo(1002);
		}
	}

	@Test
	void 과거_확정도_조회하며_현재_결과의_가격을_섞지_않고_조회로_수정하지_않는다() throws Exception {
		jdbc.update("UPDATE work_result SET summary_json='{\"choices\":[{\"total_krw\":999999}]}' WHERE result_id=2001");
		var before = jdbc.queryForMap("SELECT * FROM work_confirmation WHERE confirmation_id=3001");
		var session = jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500");
		mvc.perform(get("/api/v1/work-confirmations/3001")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.is_current_version").value(false))
				.andExpect(jsonPath("$.data.selected_snapshot_json.choice.total_krw").value(120400))
				.andExpect(jsonPath("$.data.selected_snapshot_json.detail.lines[0].pack_count").value(2))
				.andExpect(jsonPath("$.data.selected_snapshot_json.choice.note").value(nullValue()));
		assertThat(jdbc.queryForMap("SELECT * FROM work_confirmation WHERE confirmation_id=3001")).isEqualTo(before);
		assertThat(jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500")).isEqualTo(session);
	}

	@Test
	void 새_입력_후에도_확정_내용은_유지하고_현재유효성만_바뀐다() throws Exception {
		jdbc.update("UPDATE work_session SET current_version=3, step='review' WHERE session_id=500");
		mvc.perform(get("/api/v1/work-confirmations/3002")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.is_current_version").value(false))
				.andExpect(jsonPath("$.data.selected_snapshot_json.choice.total_krw").value(120400));
	}

	@ParameterizedTest @ValueSource(longs = {3999, 999999})
	void 남의_확정과_없는_확정은_같은_404(long id) throws Exception {
		mvc.perform(get("/api/v1/work-confirmations/" + id)).andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"))
				.andExpect(jsonPath("$.data.detail_code").value("CONFIRMATION_NOT_FOUND"))
				.andExpect(jsonPath("$.message").value("확정 기록을 찾을 수 없습니다."));
	}

	@Test
	void 복제_매장과_업무_버전_기능이_변조돼도_실제_소속을_따른다() throws Exception {
		jdbc.update("UPDATE work_confirmation SET store_id=20, session_id=600, version_no=2, feature_type='operation' WHERE confirmation_id=3001");
		jdbc.update("UPDATE work_confirmation SET store_id=10, session_id=500, version_no=2 WHERE confirmation_id=3999");
		mvc.perform(get("/api/v1/work-confirmations/3001")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.session_id").value(500))
				.andExpect(jsonPath("$.data.feature_type").value("purchase"))
				.andExpect(jsonPath("$.data.is_current_version").value(false));
		mvc.perform(get("/api/v1/work-confirmations/3999")).andExpect(status().isNotFound());
	}

	@Test
	void 운영_보존본과_확인_경고를_조회한다() throws Exception {
		jdbc.update("UPDATE work_confirmation SET acknowledged_warnings_json='[\"SIMULATED_CONDITIONS\"]', "
				+ "selected_snapshot_json='{\"choice\":{\"choice_key\":\"CURRENT\",\"average_wait\":1.23456789},\"simulated\":true}' WHERE confirmation_id=3003");
		mvc.perform(get("/api/v1/work-confirmations/3003")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.feature_type").value("operation"))
				.andExpect(jsonPath("$.data.selected_choice_key").value("CURRENT"))
				.andExpect(jsonPath("$.data.acknowledged_warnings_json[0]").value("SIMULATED_CONDITIONS"))
				.andExpect(jsonPath("$.data.selected_snapshot_json.simulated").value(true));
	}

	@Test
	void 저장된_경고가_객체_배열이면_라벨도_그대로_내려준다() throws Exception {
		jdbc.update("UPDATE work_confirmation SET acknowledged_warnings_json='[{\"warning_id\":\"VAT_UNKNOWN\",\"label\":\"부가세 미확인\"}]' WHERE confirmation_id=3002");
		mvc.perform(get("/api/v1/work-confirmations/3002")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.acknowledged_warnings_json[0].label").value("부가세 미확인"));
	}

	@Test
	void 확인_경고가_없으면_빈_배열을_유지한다() throws Exception {
		jdbc.update("UPDATE work_confirmation SET acknowledged_warnings_json='[]' WHERE confirmation_id=3002");
		mvc.perform(get("/api/v1/work-confirmations/3002")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.acknowledged_warnings_json").isEmpty());
	}

	@Test
	void 확정_저장_API의_가려진_스냅샷을_상세에서_재현한다() throws Exception {
		jdbc.update("DELETE FROM work_confirmation WHERE confirmation_id=3002");
		jdbc.update("UPDATE work_result SET summary_json=?::jsonb WHERE result_id=2002", """
				{"choices":[{"choice_key":"purchase_1","total_krw":120400}],"warnings":[],"assumptions":["owner@example.test"]}
				""");
		String body = mvc.perform(post("/api/v1/work-results/2002/confirm").header("Idempotency-Key", "detail-integration")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expected_input_version_id\":1002,\"selected_choice_key\":\"purchase_1\"}"))
				.andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
		long id = json.readTree(body).get("data").get("confirmation_id").asLong();
		String detail = mvc.perform(get("/api/v1/work-confirmations/" + id)).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.selected_snapshot_json.choice.total_krw").value(120400))
				.andReturn().getResponse().getContentAsString();
		assertThat(detail).doesNotContain("owner@example.test").contains("[이메일]");
	}

	@Test
	void 업무를_삭제해도_확정_계획의_목록과_상세_스냅샷은_보존한다() throws Exception {
		var before = jdbc.queryForMap("SELECT * FROM work_confirmation WHERE confirmation_id=3002");
		mvc.perform(delete("/api/v1/work-sessions/500")).andExpect(status().isOk());
		mvc.perform(post("/api/v1/purchase/sessions/500/results")
				.contentType(MediaType.APPLICATION_JSON).content("{\"input_version_id\":1002}"))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.data.detail_code").value("SESSION_NOT_FOUND"));
		mvc.perform(get("/api/v1/purchase/results/2002")).andExpect(status().isOk());
		mvc.perform(delete("/api/v1/work-sessions/700")).andExpect(status().isOk());
		mvc.perform(post("/api/v1/operation/sessions/700/results").header("Idempotency-Key", "deleted-operation")
				.contentType(MediaType.APPLICATION_JSON).content("{\"input_version_id\":1003}"))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.data.detail_code").value("SESSION_NOT_FOUND"));
		mvc.perform(get("/api/v1/work-confirmations").param("session_id", "500"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(2));
		mvc.perform(get("/api/v1/work-confirmations/3002"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.selected_snapshot_json.choice.total_krw").value(120400));
		assertThat(jdbc.queryForMap("SELECT * FROM work_confirmation WHERE confirmation_id=3002")).isEqualTo(before);
	}

	@Test
	void 저장한_계획을_삭제해도_대화와_계산_결과는_남고_현재_조건은_다시_저장할_수_있다() throws Exception {
		jdbc.update("INSERT INTO session_message (message_id, session_id, role, content) VALUES (4001, 500, 'user', '내 대화')");
		mvc.perform(delete("/api/v1/work-confirmations/3002")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/work-confirmations/3002")).andExpect(status().isNotFound());
		mvc.perform(get("/api/v1/work-confirmations").param("session_id", "500"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].confirmation_id").value(3001));
		mvc.perform(get("/api/v1/work-sessions/500/messages"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items[0].content").value("내 대화"));
		mvc.perform(get("/api/v1/purchase/results/2002"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.confirmed_choice_key").value(nullValue()));
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=500", String.class)).isEqualTo("result");
		jdbc.update("UPDATE work_result SET summary_json='{\"choices\":[{\"choice_key\":\"purchase_1\",\"total_krw\":120400}],\"warnings\":[]}' WHERE result_id=2002");
		mvc.perform(post("/api/v1/work-results/2002/confirm").header("Idempotency-Key", "save-again-after-delete")
				.contentType(MediaType.APPLICATION_JSON).content("{\"expected_input_version_id\":1002,\"selected_choice_key\":\"purchase_1\"}"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.is_new").value(true));
	}

	@Test
	void 과거_계획_삭제는_현재_계획과_업무_단계를_바꾸지_않는다() throws Exception {
		mvc.perform(delete("/api/v1/work-confirmations/3001")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/work-confirmations/3002")).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=500", String.class)).isEqualTo("saved");
	}

	@Test
	void 이어하기에서_업무를_지운_뒤에도_저장한_계획을_별도로_삭제할_수_있다() throws Exception {
		mvc.perform(delete("/api/v1/work-sessions/500")).andExpect(status().isOk());
		mvc.perform(delete("/api/v1/work-confirmations/3002")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/work-confirmations/3002")).andExpect(status().isNotFound());
		mvc.perform(get("/api/v1/work-sessions/500")).andExpect(status().isNotFound());
		assertThat(jdbc.queryForObject("SELECT count(*) FROM work_result WHERE result_id=2002", Integer.class)).isEqualTo(1);
	}

	@Test
	void 남의_계획과_없는_계획은_삭제할_수_없다() throws Exception {
		mvc.perform(delete("/api/v1/work-confirmations/3999"))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.data.detail_code").value("CONFIRMATION_NOT_FOUND"));
		mvc.perform(delete("/api/v1/work-confirmations/99999")).andExpect(status().isNotFound());
		assertThat(jdbc.queryForObject("SELECT count(*) FROM work_confirmation WHERE confirmation_id=3999", Integer.class)).isEqualTo(1);
	}

	@Test
	void 계획_삭제는_남은_운영_계산_수를_바꾸지_않는다() throws Exception {
		jdbc.update("UPDATE work_session SET active_operation_runs=1, step='saved' WHERE session_id=700");
		mvc.perform(delete("/api/v1/work-confirmations/3003")).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=700", Integer.class)).isEqualTo(1);
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=700", String.class)).isEqualTo("running");
		mvc.perform(delete("/api/v1/work-sessions/700")).andExpect(status().isBadRequest());
	}

	@ParameterizedTest
	@ValueSource(strings = {"abc", "0", "-1", "999999999999999999999999"})
	void 잘못된_계획_삭제_번호는_400이다(String id) throws Exception {
		mvc.perform(delete("/api/v1/work-confirmations/" + id)).andExpect(status().isBadRequest());
	}

	private void insert(long confirmation, long result, long version, long session, long store, int no, String feature) {
		jdbc.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json, input_confirmed_by, input_confirmed_at)
				VALUES (?, ?, ?, 'v1', '{}', 'demo-owner', now())
				""", version, session, no);
		jdbc.update("""
				INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no, feature_type, request_key, response_status, summary_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, 'ok', '{"choices":[],"warnings":[]}')
				""", result, version, session, store, no, feature, "result-" + result);
		jdbc.update("""
				INSERT INTO work_confirmation (confirmation_id, result_id, input_version_id, session_id, store_id,
				    version_no, feature_type, selected_choice_key, confirmed_by, confirmed_at, confirm_request_key,
				    request_fingerprint, acknowledged_warnings_json, selected_snapshot_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'demo-owner', '2026-11-13T10:20:00+09:00', ?, ?, '["VAT_UNKNOWN"]',
				    '{"choice":{"choice_key":"purchase_1","total_krw":120400,"note":null},"detail":{"lines":[{"pack_count":2}]},"warnings":[],"assumptions":[]}')
				""", confirmation, result, version, session, store, no, feature,
				"operation".equals(feature) ? "CURRENT" : "purchase_1", "confirm-" + confirmation, "a".repeat(64));
	}
}
