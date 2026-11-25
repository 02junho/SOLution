package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.concurrent.TimeUnit;
import java.util.stream.Stream;

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
import org.springframework.test.web.servlet.ResultActions;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {"demo.owner-key=demo-owner", "demo.seed=false"})
@AutoConfigureMockMvc
@Testcontainers
class WorkResultConfirmApiIntegrationTest {

	@Container @ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired private MockMvc mvc;
	@Autowired private JdbcTemplate jdbc;
	@LocalServerPort private int port;

	private static final String SUMMARY = """
			{"choices":[
			 {"choice_key":"purchase_1","available":true,"total_krw":120400,"warning_ids":["VAT_UNKNOWN"]},
			 {"choice_key":"purchase_2","available":true,"same_as":"purchase_1"},
			 {"choice_key":"unavailable","available":false},
			 {"choice_key":"baseline","confirmable":false}],
			 "warnings":[{"warning_id":"VAT_UNKNOWN","requires_ack":true,"choice_keys":["purchase_1"]},
			 {"warning_id":"OTHER","requires_ack":true,"choice_keys":["another_choice"]},
			 {"warning_id":"OPTIONAL","requires_ack":false}],"assumptions":["테스트 조건"]}
			""";

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
				VALUES (500, 10, 'purchase', 'form', '확정 테스트', 2, 'result'),
				       (600, 20, 'purchase', 'form', '남의 업무', 1, 'result')
				""");
		jdbc.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json,
				    input_confirmed_by, input_confirmed_at)
				VALUES (1001, 500, 1, 'purchase.v1', '{}', 'demo-owner', now()),
				       (1002, 500, 2, 'purchase.v1', '{}', 'demo-owner', now()),
				       (1003, 600, 1, 'purchase.v1', '{}', 'other', now())
				""");
		insertResult(2001, 1002, 500, 2);
		insertResult(2002, 1002, 500, 2);
		insertResult(2003, 1001, 500, 1);
		insertResult(3001, 1003, 600, 1);
	}

	@Test
	void 선택안의_품목과_거래처명은_해당_입력버전에서_복사해_보존한다() throws Exception {
		jdbc.update("UPDATE work_version SET input_json=?::jsonb WHERE input_version_id=1002", """
				{"items":[{"item_id":"coffee","item_name":"확정 당시 원두"}],
				 "suppliers":[{"supplier_id":"a","supplier_name":"확정 당시 거래처"}]}
				""");
		jdbc.update("UPDATE work_result SET detail_json=?::jsonb WHERE result_id=2001", """
				{"choices":[{"choice_key":"purchase_1","lines":[
				 {"item_id":"coffee","supplier_id":"a","item_name":"다른 이름","line_krw":120400}]}]}
				""");
		confirm(2001, "preserve-names", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		long id = jdbc.queryForObject("SELECT confirmation_id FROM work_confirmation", Long.class);
		jdbc.update("INSERT INTO work_version(input_version_id,session_id,version_no,schema_version,input_json) VALUES (1004,500,3,'purchase.v1','{}')");
		jdbc.update("UPDATE work_session SET current_version=3 WHERE session_id=500");
		jdbc.update("UPDATE work_result SET detail_json='{}' WHERE result_id=2001");
		mvc.perform(get("/api/v1/work-confirmations/" + id)).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.is_current_version").value(false))
				.andExpect(jsonPath("$.data.selected_snapshot_json.detail.lines[0].item_name").value("확정 당시 원두"))
				.andExpect(jsonPath("$.data.selected_snapshot_json.detail.lines[0].supplier_name").value("확정 당시 거래처"))
				.andExpect(jsonPath("$.data.selected_snapshot_json.detail.lines[0].line_krw").value(120400));
	}

	@Test
	void 서버_값과_선택_스냅샷을_저장하고_확정_단계로_전환한다() throws Exception {
		confirm(2001, "first", body("purchase_1", "[\"VAT_UNKNOWN\"]"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.is_new").value(true))
				.andExpect(jsonPath("$.data.is_current_version").value(true))
				.andExpect(jsonPath("$.data.confirmed_by").value("demo-owner"))
				.andExpect(jsonPath("$.message").value("구매안을 저장했어요."))
				.andExpect(jsonPath("$.data.step").value("saved"));
		var row = jdbc.queryForMap("SELECT * FROM work_confirmation");
		assertThat(row.get("request_fingerprint").toString()).matches("[0-9a-f]{64}");
		assertThat(row.get("confirmed_at")).isNotNull();
		assertThat(row.get("version_no")).isEqualTo(2);
		assertThat(row.get("store_id")).isEqualTo(10L);
		assertThat(jdbc.queryForObject("SELECT selected_snapshot_json->'choice'->>'total_krw' FROM work_confirmation", String.class)).isEqualTo("120400");
		assertThat(jdbc.queryForObject("SELECT selected_snapshot_json->'detail'->'lines'->>0 FROM work_confirmation", String.class)).isEqualTo("stored-line");
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=500", String.class)).isEqualTo("saved");
	}

	@Test
	void 경고_순서와_중복은_정규화하고_재요청은_기존값을_보존한다() throws Exception {
		confirm(2001, "repeat", body("purchase_1", "[\"OPTIONAL\",\"VAT_UNKNOWN\",\"OPTIONAL\"]"))
				.andExpect(status().isOk());
		var before = jdbc.queryForMap("SELECT * FROM work_confirmation");
		confirm(2001, "repeat", body("purchase_1", "[\"VAT_UNKNOWN\",\"OPTIONAL\"]"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.is_new").value(false));
		assertThat(jdbc.queryForMap("SELECT * FROM work_confirmation")).isEqualTo(before);
	}

	@Test
	void 새_버전_이후에도_동일_키는_기존_확정을_반환하고_새_세션상태를_바꾸지_않는다() throws Exception {
		confirm(2001, "old", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		jdbc.update("UPDATE work_session SET current_version=3, step='review' WHERE session_id=500");
		confirm(2001, "old", body("purchase_1", "[\"VAT_UNKNOWN\"]"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.is_new").value(false))
				.andExpect(jsonPath("$.data.is_current_version").value(false))
				.andExpect(jsonPath("$.data.step").value("review"));
		confirm(2001, "new", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("STALE_VERSION"));
	}

	@Test
	void 같은_키의_다른_선택안은_거절한다() throws Exception {
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		confirm(2001, "key", body("purchase_2", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("IDEMPOTENCY_KEY_REUSED"));
	}

	@Test
	void 같은_버전의_다른_결과와_다른_키로_이중_확정할_수_없다() throws Exception {
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		confirm(2002, "other-key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("VERSION_ALREADY_CONFIRMED"));
		assertThat(count()).isEqualTo(1);
	}

	@Test
	void 옛_결과와_화면의_버전_불일치를_거절한다() throws Exception {
		confirm(2003, "old", body("purchase_1", "[\"VAT_UNKNOWN\"]").replace("1002", "1001"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("STALE_VERSION"));
		confirm(2001, "mismatch", body("purchase_1", "[\"VAT_UNKNOWN\"]").replace("1002", "9999"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("STALE_VERSION"));
		assertThat(count()).isZero();
	}

	@Test
	void 입력_미확인은_거절한다() throws Exception {
		jdbc.update("UPDATE work_version SET input_confirmed_by=NULL, input_confirmed_at=NULL WHERE input_version_id=1002");
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("INPUT_NOT_CONFIRMED"));
		assertThat(count()).isZero();
	}

	@ParameterizedTest @ValueSource(strings = {"needs_input", "infeasible", "error"})
	void ok가_아닌_결과는_거절한다(String responseStatus) throws Exception {
		jdbc.update("UPDATE work_result SET response_status=? WHERE result_id=2001", responseStatus);
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_READY"));
	}

	@ParameterizedTest @ValueSource(strings = {"missing", "baseline", "unavailable"})
	void 실제_선택_불가한_안은_거절한다(String choice) throws Exception {
		confirm(2001, "key", body(choice, "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("INVALID_CHOICE"));
	}

	@Test
	void alias도_원본_안의_필수_경고를_확인하고_실제_금액과_상세를_저장한다() throws Exception {
		confirm(2001, "alias", body("purchase_2", "[]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("WARNINGS_NOT_ACKNOWLEDGED"));
		confirm(2001, "alias", body("purchase_2", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("SELECT selected_choice_key FROM work_confirmation", String.class)).isEqualTo("purchase_2");
		assertThat(jdbc.queryForObject("SELECT selected_snapshot_json->'choice'->>'total_krw' FROM work_confirmation", String.class)).isEqualTo("120400");
	}

	@Test
	void 필수_경고_미확인과_존재하지_않는_경고는_거절한다() throws Exception {
		confirm(2001, "key", body("purchase_1", "[]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("WARNINGS_NOT_ACKNOWLEDGED"));
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\",\"invented\"]")).andExpect(status().isBadRequest());
		assertThat(count()).isZero();
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=500", String.class)).isEqualTo("result");
	}

	@ParameterizedTest @ValueSource(longs = {3001, 9999})
	void 남의_결과와_없는_결과는_404(long id) throws Exception {
		confirm(id, "key", body("purchase_1", "[]")).andExpect(status().isNotFound())
				.andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_FOUND"));
	}

	@Test
	void 조회용_복제_값을_믿지_않고_실제_경로에서_매장과_버전을_읽는다() throws Exception {
		jdbc.update("UPDATE work_result SET store_id=20, version_no=99, feature_type='operation' WHERE result_id=2001");
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.store_id").value(10)).andExpect(jsonPath("$.data.version_no").value(2))
				.andExpect(jsonPath("$.data.feature_type").value("purchase"));
	}

	@Test
	void 확인자_금액_시각_fingerprint를_화면에서_받지_않는다() throws Exception {
		String request = body("purchase_1", "[\"VAT_UNKNOWN\"]");
		request = request.substring(0, request.length() - 1) + ",\"confirmed_by\":\"attacker\",\"total_krw\":1,"
				+ "\"confirmed_at\":\"2000-01-01T00:00:00Z\",\"request_fingerprint\":\"fake\"}";
		confirm(2001, "key", request).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("SELECT confirmed_by FROM work_confirmation", String.class)).isEqualTo("demo-owner");
		assertThat(jdbc.queryForObject("SELECT request_fingerprint FROM work_confirmation", String.class)).isNotEqualTo("fake");
		assertThat(jdbc.queryForObject("SELECT selected_snapshot_json->'choice'->>'total_krw' FROM work_confirmation", String.class)).isEqualTo("120400");
	}

	@Test
	void 계약이_없는_운영_결과는_확정하지_않는다() throws Exception {
		jdbc.update("UPDATE work_session SET feature_type='operation' WHERE session_id=500");
		confirm(2001, "key", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_READY"));
		assertThat(count()).isZero();
	}

	@Test
	void malformed_경고는_필수확인을_우회하지_않는다() throws Exception {
		jdbc.update("UPDATE work_result SET summary_json=jsonb_set(summary_json, '{warnings}', '[{\"warning_id\":\"VAT_UNKNOWN\"}]') WHERE result_id=2001");
		confirm(2001, "key", body("purchase_1", "[]")).andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_READY"));
	}

	@Test
	void 헤더와_필수_본문의_오류는_400() throws Exception {
		mvc.perform(post("/api/v1/work-results/2001/confirm").contentType(MediaType.APPLICATION_JSON)
				.content(body("purchase_1", "[]"))).andExpect(status().isBadRequest());
		confirm(2001, " ", body("purchase_1", "[]")).andExpect(status().isBadRequest());
		confirm(2001, "x".repeat(101), body("purchase_1", "[]")).andExpect(status().isBadRequest());
		for (String request : new String[]{"{}", "{\"expected_input_version_id\":1002,\"selected_choice_key\":\"\"}", "{broken"}) {
			confirm(2001, "key", request).andExpect(status().isBadRequest());
		}
	}

	@Test
	void 실제_HTTP_동시_동일키는_하나만_저장하고_나머지는_재전송한다() throws Exception {
		try (HttpClient client = HttpClient.newHttpClient()) {
			var request = httpRequest(2001, "race", body("purchase_1", "[\"VAT_UNKNOWN\"]"));
			var a = client.sendAsync(request, HttpResponse.BodyHandlers.ofString());
			var b = client.sendAsync(request, HttpResponse.BodyHandlers.ofString());
			var responses = Stream.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS)).toList();
			assertThat(responses).allSatisfy(r -> assertThat(r.statusCode()).isEqualTo(200));
			assertThat(responses.stream().filter(r -> r.body().contains("\"is_new\":true")).count()).isEqualTo(1);
			assertThat(count()).isEqualTo(1);
		}
	}

	@Test
	void 같은_버전의_동시_다른키는_하나만_성공한다() throws Exception {
		try (HttpClient client = HttpClient.newHttpClient()) {
			var a = client.sendAsync(httpRequest(2001, "one", body("purchase_1", "[\"VAT_UNKNOWN\"]")), HttpResponse.BodyHandlers.ofString());
			var b = client.sendAsync(httpRequest(2002, "two", body("purchase_1", "[\"VAT_UNKNOWN\"]")), HttpResponse.BodyHandlers.ofString());
			assertThat(Stream.of(a.get(10, TimeUnit.SECONDS).statusCode(), b.get(10, TimeUnit.SECONDS).statusCode()).sorted().toList())
					.containsExactly(200, 400);
			assertThat(count()).isEqualTo(1);
		}
	}

	@Test
	void 다른_세션의_동시_동일키도_500_대신_키재사용_오류다() throws Exception {
		jdbc.update("UPDATE store SET owner_key='demo-owner' WHERE store_id=20");
		try (HttpClient client = HttpClient.newHttpClient()) {
			var a = client.sendAsync(httpRequest(2001, "global", body("purchase_1", "[\"VAT_UNKNOWN\"]")), HttpResponse.BodyHandlers.ofString());
			var b = client.sendAsync(httpRequest(3001, "global", body("purchase_1", "[\"VAT_UNKNOWN\"]").replace("1002", "1003")), HttpResponse.BodyHandlers.ofString());
			var responses = Stream.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS)).toList();
			assertThat(responses.stream().map(HttpResponse::statusCode).sorted().toList()).containsExactly(200, 400);
			assertThat(responses.stream().filter(r -> r.statusCode() == 400).findFirst().orElseThrow().body()).contains("IDEMPOTENCY_KEY_REUSED");
			assertThat(count()).isEqualTo(1);
		}
	}

	@Test
	void 세션_단계_갱신이_실패하면_확정_INSERT도_롤백한다() throws Exception {
		jdbc.execute("CREATE FUNCTION reject_saved() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$");
		jdbc.execute("CREATE TRIGGER reject_saved BEFORE UPDATE ON work_session FOR EACH ROW EXECUTE FUNCTION reject_saved()");
		try {
			confirm(2001, "rollback", body("purchase_1", "[\"VAT_UNKNOWN\"]"))
					.andExpect(status().isInternalServerError())
					.andExpect(jsonPath("$.data.detail_code").value("INTERNAL_ERROR"))
					.andExpect(jsonPath("$.message").value("저장 중 오류가 발생했습니다."));
			assertThat(count()).isZero();
			assertThat(jdbc.queryForObject("SELECT payload_json->>'detail_code' FROM execution_log WHERE name='confirm'", String.class))
					.isEqualTo("INTERNAL_ERROR");
		}
		finally {
			jdbc.execute("DROP TRIGGER reject_saved ON work_session");
			jdbc.execute("DROP FUNCTION reject_saved()");
		}
	}

	@Test
	void 완료된_운영안은_모의조건_경고_확인_후_저장한다() throws Exception {
		operationSummary("true");
		String body = "{\"expected_input_version_id\":1002,\"selected_choice_key\":\"CURRENT\","
				+ "\"acknowledged_warning_ids\":[\"SIMULATED_CONDITIONS\"]}";
		confirm(2001, "operation", body).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.feature_type").value("operation"))
				.andExpect(jsonPath("$.message").value("운영안을 저장했어요."));
		assertThat(count()).isEqualTo(1);
	}

	@ParameterizedTest @ValueSource(strings = {"false", "null", "1", "\"true\""})
	void 운영_완료_필드가_참이_아니면_거절한다(String complete) throws Exception {
		operationSummary(complete);
		confirm(2001, "operation", "{\"expected_input_version_id\":1002,\"selected_choice_key\":\"CURRENT\"}")
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_READY"));
		assertThat(count()).isZero();
	}

	@Test
	void 운영_완료라도_모의조건_경고를_확인해야_한다() throws Exception {
		operationSummary("true");
		confirm(2001, "operation", "{\"expected_input_version_id\":1002,\"selected_choice_key\":\"CURRENT\"}")
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("WARNINGS_NOT_ACKNOWLEDGED"));
		jdbc.update("UPDATE work_result SET summary_json=jsonb_set(summary_json, '{warnings}', '[]') WHERE result_id=2001");
		confirm(2001, "operation", "{\"expected_input_version_id\":1002,\"selected_choice_key\":\"CURRENT\"}")
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_READY"));
	}

	@Test
	void 새_참고_경고는_필수확인_없이_저장한다() throws Exception {
		jdbc.update("UPDATE work_result SET summary_json=jsonb_set(summary_json, '{warnings}', "
				+ "summary_json->'warnings' || '[{\"warning_id\":\"END_STOCK_OVER_LIMIT\",\"requires_ack\":false}]'::jsonb) WHERE result_id=2001");
		confirm(2001, "reference-warning", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
	}

	@Test
	void 스냅샷의_중첩_키와_문자열을_가리고_금액과_긴_식별자를_보존한다() throws Exception {
		jdbc.update("UPDATE work_result SET summary_json=jsonb_set(summary_json, '{assumptions}', "
				+ "'[\"담당자: 김영희 010-1234-5678 owner@example.test\"]'), detail_json=?::jsonb WHERE result_id=2001", """
				{"choices":[{"choice_key":"purchase_1","supplier":{"owner@example.test":"010-1234-5678",
				"email":"owner@example.test","phone_number":1012345678,"contact_name":"박민수","total_krw":120400,"reference":"1010123456789123"}}]}
				""");
		confirm(2001, "privacy", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		String stored = jdbc.queryForObject("SELECT selected_snapshot_json::text FROM work_confirmation", String.class);
		assertThat(stored).doesNotContain("010-1234-5678", "owner@example.test", "김영희", "1012345678,", "박민수")
				.contains("[전화번호]", "[이메일]", "120400", "1010123456789123");
		assertThat(jdbc.queryForObject("SELECT selected_snapshot_json->'choice'->>'total_krw' FROM work_confirmation", String.class))
				.isEqualTo("120400");
	}

	@Test
	void 가림_후_키가_충돌하면_스냅샷을_조용히_덮어쓰지_않는다() throws Exception {
		jdbc.update("UPDATE work_result SET detail_json=?::jsonb WHERE result_id=2001", """
				{"choices":[{"choice_key":"purchase_1","a@example.test":1,"b@example.test":2}]}
				""");
		confirm(2001, "collision", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isBadRequest());
		assertThat(count()).isZero();
	}

	@Test
	void 감사로그는_성공과_차단_코드만_별도로_기록한다() throws Exception {
		confirm(2001, "caller@example.test", body("purchase_1", "[]")).andExpect(status().isBadRequest());
		confirm(2001, "caller@example.test", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
		var logs = jdbc.queryForList("SELECT status, payload_json::text, request_key FROM execution_log WHERE name='confirm' ORDER BY log_id");
		assertThat(logs).hasSize(2);
		assertThat(logs.get(0).get("status")).isEqualTo("refused");
		assertThat(logs.get(1).get("status")).isEqualTo("success");
		assertThat(logs.toString()).contains("policy_version", "WARNINGS_NOT_ACKNOWLEDGED", "CONFIRMED")
				.doesNotContain("caller@example.test", "120400");
	}

	@Test
	void 감사로그_실패가_확정과_멱등_재전송을_막지_않는다() throws Exception {
		jdbc.execute("CREATE FUNCTION reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit failure'; END $$");
		jdbc.execute("CREATE TRIGGER reject_audit BEFORE INSERT ON execution_log FOR EACH ROW EXECUTE FUNCTION reject_audit()");
		try {
			confirm(2001, "audit-failure", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
			confirm(2001, "audit-failure", body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk())
					.andExpect(jsonPath("$.data.is_new").value(false));
			assertThat(count()).isEqualTo(1);
			assertThat(jdbc.queryForObject("SELECT count(*) FROM execution_log", Integer.class)).isZero();
		}
		finally {
			jdbc.execute("DROP TRIGGER reject_audit ON execution_log");
			jdbc.execute("DROP FUNCTION reject_audit()");
		}
	}

	@ParameterizedTest @ValueSource(strings = {"not-a-uuid", "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"})
	void 비_UUID와_정확히100자_요청키를_허용한다(String key) throws Exception {
		confirm(2001, key, body("purchase_1", "[\"VAT_UNKNOWN\"]")).andExpect(status().isOk());
	}

	private void operationSummary(String complete) {
		jdbc.update("UPDATE work_session SET feature_type='operation' WHERE session_id=500");
		jdbc.update("UPDATE work_result SET detail_json=NULL, summary_json=?::jsonb WHERE result_id=2001",
				"{\"complete\":" + complete + ",\"choices\":[{\"choice_key\":\"CURRENT\"}],"
				+ "\"warnings\":[{\"warning_id\":\"SIMULATED_CONDITIONS\",\"requires_ack\":true}]}");
	}

	private void insertResult(long result, long version, long session, int versionNo) {
		jdbc.update("""
				INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no,
				    feature_type, request_key, response_status, summary_json, detail_json)
				VALUES (?, ?, ?, 10, ?, 'purchase', ?, 'ok', ?::jsonb,
				    '{"choices":[{"choice_key":"purchase_1","lines":["stored-line"]}]}')
				""", result, version, session, versionNo, "result-" + result, SUMMARY);
	}

	private int count() {
		return jdbc.queryForObject("SELECT count(*) FROM work_confirmation", Integer.class);
	}

	private String body(String choice, String warnings) {
		return "{\"expected_input_version_id\":1002,\"selected_choice_key\":\"" + choice + "\",\"acknowledged_warning_ids\":" + warnings + "}";
	}

	private ResultActions confirm(long result, String key, String body) throws Exception {
		return mvc.perform(post("/api/v1/work-results/" + result + "/confirm").header("Idempotency-Key", key)
				.contentType(MediaType.APPLICATION_JSON).content(body));
	}

	private HttpRequest httpRequest(long result, String key, String body) {
		return HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/work-results/" + result + "/confirm"))
				.header("Idempotency-Key", key).header("Content-Type", "application/json")
				.POST(HttpRequest.BodyPublishers.ofString(body)).build();
	}
}
