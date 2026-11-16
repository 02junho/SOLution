package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import java.util.Map;
import java.util.List;
import static org.hamcrest.Matchers.nullValue;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;

/**
 * 업무 세션 시작·문맥 조회 API의 통합 테스트.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>테스트가 돌 때 임시 PostgreSQL을 Docker로 띄우고(Testcontainers), Flyway가 V1 스키마를 만든 뒤,
 * 실제 서버 문맥(Spring) + 실제 DB로 API를 호출한다. 컨트롤러·검증·서비스·SQL·DB INSERT까지 끝까지 확인한다.
 * (Docker가 떠 있어야 실행된다. 단위 테스트와 달리 가짜 서비스를 쓰지 않는다.)
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "demo.owner-key=demo-owner")
@AutoConfigureMockMvc
@Testcontainers
class WorkSessionApiIntegrationTest {

	// V1 마이그레이션의 vector 확장을 지원하도록 Compose와 같은 DB 이미지를 사용한다.
	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@org.springframework.boot.test.web.server.LocalServerPort
	private int port;

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@MockitoBean
	private AiServerClient aiServerClient;

	/** 매 테스트 전에 깨끗이 비우고, 시연 사용자(demo-owner) 소유 매장과 남의 매장을 하나씩 넣는다. */
	@BeforeEach
	void seed() {
		given(aiServerClient.post(anyString(), any(), anyString(), any()))
				.willThrow(new AiServerException("테스트용 AI 연결 실패"));
		jdbcTemplate.update("DELETE FROM session_message");
		jdbcTemplate.update("DELETE FROM work_confirmation");
		jdbcTemplate.update("DELETE FROM work_result");
		jdbcTemplate.update("DELETE FROM work_version");
		jdbcTemplate.update("DELETE FROM work_session");
		jdbcTemplate.update("DELETE FROM store");
		jdbcTemplate.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time,
				                   settings_version, profile_json, created_at, updated_at)
				VALUES (10, 'demo-owner', '데모 카페', '07:00:00', '19:00:00', 1, '{}'::jsonb, now(), now())
				""");
		jdbcTemplate.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time,
				                   settings_version, profile_json, created_at, updated_at)
				VALUES (20, 'someone-else', '남의 카페', '07:00:00', '19:00:00', 1, '{}'::jsonb, now(), now())
				""");
	}

	@Test
	void 업무시작_API가_실제_DB에_세션을_저장한다() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"feature_type\": \"purchase\", \"input_method\": \"agent\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.step").value("input"))
				.andExpect(jsonPath("$.data.current_version").value(1));

		Integer count = jdbcTemplate.queryForObject(
				"SELECT count(*) FROM work_session WHERE store_id = 10 AND step = 'input' AND current_version = 1",
				Integer.class);
		assertThat(count).isEqualTo(1);
	}

	@Test
	void 없는_매장이면_404이고_DB에_저장되지_않는다() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 999, \"feature_type\": \"purchase\", \"input_method\": \"agent\"}"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"));

		Integer count = jdbcTemplate.queryForObject("SELECT count(*) FROM work_session", Integer.class);
		assertThat(count).isEqualTo(0);
	}

	@Test
	void 남의_매장이면_404이고_DB에_저장되지_않는다() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 20, \"feature_type\": \"purchase\", \"input_method\": \"agent\"}"))
				.andExpect(status().isNotFound());

		Integer count = jdbcTemplate.queryForObject(
				"SELECT count(*) FROM work_session WHERE store_id = 20", Integer.class);
		assertThat(count).isEqualTo(0);
	}
	@Test
	void 내_업무_문맥을_실제_DB에서_복원한다() throws Exception {
		jdbcTemplate.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title,
				                          current_version, step, created_at, updated_at)
				VALUES (500, 10, 'purchase', 'agent', '테스트 업무', 1, 'input', now(), now())
				""");

		mockMvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.session_id").value(500))
				.andExpect(jsonPath("$.data.current_version").value(1))
				.andExpect(jsonPath("$.data.input_confirmed").value(false))
				.andExpect(jsonPath("$.data.has_confirmation").value(false));
	}

	@Test
	void 남의_업무_문맥은_404() throws Exception {
		jdbcTemplate.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title,
				                          current_version, step, created_at, updated_at)
				VALUES (600, 20, 'purchase', 'agent', '남의 업무', 1, 'input', now(), now())
				""");

		mockMvc.perform(get("/api/v1/work-sessions/600"))
				.andExpect(status().isNotFound());
	}

	@Test
	void 없는_업무_문맥은_404() throws Exception {
		mockMvc.perform(get("/api/v1/work-sessions/999999"))
				.andExpect(status().isNotFound());
	}
	@Test
	void 현재_버전의_최신_결과와_입력확인_상태를_읽고_조회로_수정하지_않는다() throws Exception {
		insertSession(500, 10, 2);
		insertVersion(1001, 500, 1, true);
		insertVersion(1002, 500, 2, true);
		insertResult(2001, 1002, 500, 2, "2026-11-13T10:00:00+09:00");
		insertResult(2002, 1002, 500, 2, "2026-11-13T11:00:00+09:00");
		insertResult(2003, 1002, 500, 2, "2026-11-13T11:00:00+09:00");
		// 이전 버전 결과의 시각이 더 늦어도 현재 버전 결과와 섞이지 않아야 한다.
		insertResult(2999, 1001, 500, 1, "2026-11-13T12:00:00+09:00");
		var before = jdbcTemplate.queryForMap("SELECT * FROM work_session WHERE session_id = 500");

		mockMvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.current_version_id").value(1002))
				.andExpect(jsonPath("$.data.input_confirmed").value(true))
				.andExpect(jsonPath("$.data.latest_result_id").value(2003))
				.andExpect(jsonPath("$.data.has_confirmation").value(false));

		assertThat(jdbcTemplate.queryForMap("SELECT * FROM work_session WHERE session_id = 500"))
				.isEqualTo(before);
	}

	@Test
	void 현재_입력_버전이_없으면_이전_버전의_입력확인과_결과를_가져오지_않는다() throws Exception {
		insertSession(500, 10, 2);
		insertVersion(1001, 500, 1, true);
		insertResult(2001, 1001, 500, 1, "2026-11-13T10:00:00+09:00");

		mockMvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.current_version_id").value(nullValue()))
				.andExpect(jsonPath("$.data.input_confirmed").value(false))
				.andExpect(jsonPath("$.data.latest_result_id").value(nullValue()));
	}

	@Test
	void 확정_유무는_복제된_업무번호가_아닌_실제_입력버전의_업무로_판단한다() throws Exception {
		insertSession(500, 10, 2);
		insertSession(600, 10, 1);
		insertVersion(1001, 500, 1, true);
		insertVersion(1002, 500, 2, false);
		insertResult(2001, 1001, 500, 1, "2026-11-13T10:00:00+09:00");
		// V1에서 session_id는 FK가 없는 조회용 복제값이다. 실제 소속은 입력 버전으로 검증한다.
		jdbcTemplate.update("""
				INSERT INTO work_confirmation (confirmation_id, result_id, input_version_id, session_id,
				    store_id, version_no, feature_type, selected_choice_key, confirmed_by,
				    confirm_request_key, request_fingerprint, selected_snapshot_json)
				VALUES (3001, 2001, 1001, 600, 10, 1, 'purchase', 'purchase_1', 'demo-owner',
				    'confirm-3001', ?, '{}'::jsonb)
				""", "a".repeat(64));

		mockMvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.input_confirmed").value(false))
				.andExpect(jsonPath("$.data.latest_result_id").value(nullValue()))
				.andExpect(jsonPath("$.data.has_confirmation").value(true));
		mockMvc.perform(get("/api/v1/work-sessions/600"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.has_confirmation").value(false));
	}

	@Test
	void 운영_폼_업무도_동일한_응답_형식으로_조회한다() throws Exception {
		insertSession(500, 10, 0);
		jdbcTemplate.update("UPDATE work_session SET feature_type = 'operation', input_method = 'form' "
				+ "WHERE session_id = 500");

		mockMvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.store_id").value(10))
				.andExpect(jsonPath("$.data.feature_type").value("operation"))
				.andExpect(jsonPath("$.data.input_method").value("form"))
				.andExpect(jsonPath("$.data.current_version").value(0))
				.andExpect(jsonPath("$.data.current_version_id").value(nullValue()))
				.andExpect(jsonPath("$.data.created_at").isString())
				.andExpect(jsonPath("$.data.updated_at").isString());
	}

	@Test
	void 업무_목록을_최신순으로_실제_DB에서_돌려준다() throws Exception {
		insertListSession(701, 10, "purchase", "2026-11-13T08:00:00+09:00");
		insertListSession(702, 10, "operation", "2026-11-13T09:00:00+09:00");
		insertListSession(703, 10, "purchase", "2026-11-13T10:00:00+09:00");
		// 남의 매장 업무는 목록에 보이면 안 된다.
		insertListSession(704, 20, "purchase", "2026-11-13T11:00:00+09:00");

		mockMvc.perform(get("/api/v1/work-sessions"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.items.length()").value(3))
				.andExpect(jsonPath("$.data.items[0].session_id").value(703))
				.andExpect(jsonPath("$.data.items[2].session_id").value(701))
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
	}

	@Test
	void 목록은_feature_type으로_거른다() throws Exception {
		insertListSession(701, 10, "purchase", "2026-11-13T08:00:00+09:00");
		insertListSession(702, 10, "operation", "2026-11-13T09:00:00+09:00");

		mockMvc.perform(get("/api/v1/work-sessions").param("feature_type", "operation"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].session_id").value(702));
	}

	@Test
	void 목록은_size와_커서로_다음_페이지를_준다() throws Exception {
		insertListSession(701, 10, "purchase", "2026-11-13T08:00:00+09:00");
		insertListSession(702, 10, "purchase", "2026-11-13T09:00:00+09:00");

		// 첫 페이지: 최신 한 건 + 다음 커서
		String body = mockMvc.perform(get("/api/v1/work-sessions").param("size", "1"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].session_id").value(702))
				.andReturn().getResponse().getContentAsString();
		String nextCursor = com.jayway.jsonpath.JsonPath.read(body, "$.data.next_cursor");
		assertThat(nextCursor).isNotNull();

		// 둘째 페이지: 커서 뒤의 더 오래된 한 건
		mockMvc.perform(get("/api/v1/work-sessions").param("size", "1").param("cursor", nextCursor))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].session_id").value(701));
	}

	@Test
	void 동일_시각과_마이크로초_경계에서도_필터_페이지에_중복이나_누락이_없다() throws Exception {
		insertListSession(701, 10, "purchase", "2026-11-13T10:00:00.123455+09:00");
		insertListSession(702, 10, "purchase", "2026-11-13T10:00:00.123456+09:00");
		insertListSession(703, 10, "purchase", "2026-11-13T10:00:00.123456+09:00");
		insertListSession(704, 10, "operation", "2026-11-13T11:00:00+09:00");
		insertListSession(705, 20, "purchase", "2026-11-13T12:00:00+09:00");
		String cursor = null;
		for (int expected : new int[] {703, 702, 701}) {
			var request = get("/api/v1/work-sessions").param("feature_type", "purchase").param("size", "1");
			if (cursor != null) {
				request.param("cursor", cursor);
			}
			String body = mockMvc.perform(request)
					.andExpect(status().isOk())
					.andExpect(jsonPath("$.data.items.length()").value(1))
					.andExpect(jsonPath("$.data.items[0].session_id").value(expected))
					.andReturn().getResponse().getContentAsString();
			cursor = com.jayway.jsonpath.JsonPath.read(body, "$.data.next_cursor");
			if (expected != 701) {
				assertThat(cursor).isNotBlank();
			}
		}
		assertThat(cursor).isNull();
	}

	@Test
	void 업무가_없으면_빈_목록과_null_커서를_반환한다() throws Exception {
		mockMvc.perform(get("/api/v1/work-sessions"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.items").isEmpty())
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()))
				.andExpect(jsonPath("$.message").value(nullValue()));
	}

	@Test
	void 목록의_잘못된_필터와_커서는_공통_400_응답을_반환한다() throws Exception {
		for (String[] param : new String[][] {{"feature_type", "delivery"}, {"cursor", "!invalid!"},
				{"cursor", "bm90LWEtY3Vyc29y"}}) {
			mockMvc.perform(get("/api/v1/work-sessions").param(param[0], param[1]))
					.andExpect(status().isBadRequest())
					.andExpect(jsonPath("$.status").value("error"));
		}
	}

	@Test
	void 실제_HTTP로_목록과_문맥복원_API를_호출한다() throws Exception {
		insertListSession(701, 10, "purchase", "2026-11-13T10:00:00+09:00");
		insertListSession(702, 20, "purchase", "2026-11-13T11:00:00+09:00");
		try (var client = java.net.http.HttpClient.newHttpClient()) {
			for (String path : new String[] {"/api/v1/work-sessions?feature_type=purchase&size=1",
					"/api/v1/work-sessions/701"}) {
				var request = java.net.http.HttpRequest.newBuilder(java.net.URI.create("http://localhost:" + port + path))
						.GET().build();
				var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
				assertThat(response.statusCode()).isEqualTo(200);
				assertThat((String) com.jayway.jsonpath.JsonPath.read(response.body(), "$.status")).isEqualTo("ok");
				String idPath = path.contains("?") ? "$.data.items[0].session_id" : "$.data.session_id";
				assertThat(((Number) com.jayway.jsonpath.JsonPath.read(response.body(), idPath)).longValue()).isEqualTo(701);
				if (path.contains("?")) {
					assertThat((Object) com.jayway.jsonpath.JsonPath.read(response.body(), "$.data.next_cursor")).isNull();
				}
			}
		}
	}

	@Test
	void 폼_이벤트가_실제_DB에_미확인_입력버전을_만든다() throws Exception {
		insertSession(500, 10, 1);

		mockMvc.perform(post("/api/v1/work-sessions/500/events")
				.header("X-Request-Key", "evt-form-1")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"form\", \"form_input\": {\"budget_krw\": 100000}}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.step").value("review"))
				.andExpect(jsonPath("$.data.version_no").value(1));

		// 새 입력 버전이 생겼고, 아직 "입력 확인" 전(확인자 NULL)이어야 한다(URQ-FLW-005).
		Integer versions = jdbcTemplate.queryForObject(
				"SELECT count(*) FROM work_version WHERE session_id = 500 AND input_confirmed_by IS NULL",
				Integer.class);
		assertThat(versions).isEqualTo(1);
		// 세션 단계가 review로 바뀌어야 한다.
		String step = jdbcTemplate.queryForObject(
				"SELECT step FROM work_session WHERE session_id = 500", String.class);
		assertThat(step).isEqualTo("review");
		// 사용자·AI 메시지 두 줄이 남아야 한다(URQ-FLW-006).
		Integer messages = jdbcTemplate.queryForObject(
				"SELECT count(*) FROM session_message WHERE session_id = 500", Integer.class);
		assertThat(messages).isEqualTo(2);
	}

	@Test
	void 같은_요청키로_폼_이벤트를_두_번_보내도_버전은_하나만_생긴다() throws Exception {
		insertSession(500, 10, 1);
		String body = "{\"event_type\": \"form\", \"form_input\": {\"budget_krw\": 100000}}";
		for (int i = 0; i < 2; i++) {
			mockMvc.perform(post("/api/v1/work-sessions/500/events")
					.header("X-Request-Key", "evt-dup")
					.contentType(MediaType.APPLICATION_JSON)
					.content(body))
					.andExpect(status().isOk());
		}
		Integer versions = jdbcTemplate.queryForObject(
				"SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class);
		assertThat(versions).isEqualTo(1);
	}

	@Test
	void 대화_이벤트는_AI서버_미연결이면_502이고_DB에_쓰지_않는다() throws Exception {
		insertSession(500, 10, 1);

		// AI 클라이언트가 연결 실패를 반환하면 공통 처리기에서 502로 바꾼다.
		mockMvc.perform(post("/api/v1/work-sessions/500/events")
				.header("X-Request-Key", "evt-msg-1")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"message\", \"content\": \"우유를 2L로 바꿔줘\"}"))
				.andExpect(status().isBadGateway())
				.andExpect(jsonPath("$.status").value("error"));

		// 호출이 실패했으므로 대화·버전이 저장되면 안 된다(저장은 성공 응답 뒤에만 한다).
		Integer messages = jdbcTemplate.queryForObject(
				"SELECT count(*) FROM session_message WHERE session_id = 500", Integer.class);
		assertThat(messages).isEqualTo(0);
	}

	@Test
	void 없는_업무에_이벤트를_보내면_404() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions/999999/events")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"form\", \"form_input\": {\"a\": 1}}"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 이벤트타입이_범위_밖이면_400() throws Exception {
		insertSession(500, 10, 1);
		mockMvc.perform(post("/api/v1/work-sessions/500/events")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"delete\"}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 실제_HTTP로_폼_이벤트를_보내고_문맥을_다시_복원한다() throws Exception {
		insertSession(500, 10, 1);
		try (var client = java.net.http.HttpClient.newHttpClient()) {
			var request = java.net.http.HttpRequest.newBuilder(
					java.net.URI.create("http://localhost:" + port + "/api/v1/work-sessions/500/events"))
					.header("Content-Type", "application/json")
					.header("X-Request-Key", "http-form-1")
					.POST(java.net.http.HttpRequest.BodyPublishers.ofString(
							"{\"event_type\":\"form\",\"form_input\":{\"budget_krw\":100000}}"))
					.build();
			var response = client.send(request, java.net.http.HttpResponse.BodyHandlers.ofString());
			assertThat(response.statusCode()).isEqualTo(200);
			assertThat((String) com.jayway.jsonpath.JsonPath.read(response.body(), "$.data.step")).isEqualTo("review");
		}
		mockMvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.current_version").value(1))
				.andExpect(jsonPath("$.data.current_version_id").isNumber())
				.andExpect(jsonPath("$.data.input_confirmed").value(false));
	}

	@Test
	void 변경된_폼은_기존_확정입력을_보존하고_새_미확인_버전을_만든다() throws Exception {
		insertSession(500, 10, 1);
		insertVersion(1001, 500, 1, true);
		var before = jdbcTemplate.queryForMap("SELECT * FROM work_version WHERE input_version_id = 1001");
		mockMvc.perform(post("/api/v1/work-sessions/500/events")
				.header("X-Request-Key", "form-change")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\":\"form\",\"base_version_id\":1001,\"form_input\":{\"budget_krw\":100000}}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.version_no").value(2));
		assertThat(jdbcTemplate.queryForMap("SELECT * FROM work_version WHERE input_version_id = 1001"))
				.isEqualTo(before);
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500 "
				+ "AND version_no = 2 AND input_confirmed_by IS NULL AND input_confirmed_at IS NULL", Integer.class))
				.isEqualTo(1);
	}

	@Test
	void 동일한_폼은_새_버전을_만들거나_입력확인을_해제하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		insertVersion(1001, 500, 1, true);
		jdbcTemplate.update("UPDATE work_version SET input_json = '{\"budget_krw\":100000}'::jsonb "
				+ "WHERE input_version_id = 1001");
		mockMvc.perform(post("/api/v1/work-sessions/500/events")
				.header("X-Request-Key", "form-same")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\":\"form\",\"form_input\":{\"budget_krw\":100000}}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.input_version_id").value(1001));
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class))
				.isEqualTo(1);
		assertThat(jdbcTemplate.queryForObject("SELECT input_confirmed_at IS NOT NULL FROM work_version "
				+ "WHERE input_version_id = 1001", Boolean.class)).isTrue();
	}

	@Test
	void 다른_매장의_업무에_이벤트를_보내면_404이고_저장하지_않는다() throws Exception {
		insertSession(600, 20, 1);
		mockMvc.perform(post("/api/v1/work-sessions/600/events")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\":\"form\",\"form_input\":{\"budget_krw\":100000}}"))
				.andExpect(status().isNotFound());
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 600", Integer.class))
				.isZero();
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM session_message WHERE session_id = 600", Integer.class))
				.isZero();
	}

	@Test
	void 종류별_필수값이_없으면_400이고_저장하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		for (String body : new String[] {"{\"event_type\":\"form\"}",
				"{\"event_type\":\"message\",\"content\":\" \"}", "{\"event_type\":\"question_reply\"}"}) {
			mockMvc.perform(post("/api/v1/work-sessions/500/events")
					.contentType(MediaType.APPLICATION_JSON).content(body))
					.andExpect(status().isBadRequest());
		}
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class))
				.isZero();
	}

	@Test
	void AI_해석_성공은_새_입력버전을_저장하고_개인정보를_대화에_남기지_않는다() throws Exception {
		insertSession(500, 10, 1);
		org.mockito.Mockito.doReturn(agentInput(120000)).when(aiServerClient).post(anyString(), any(), anyString(), any());
		postEvent("agent-success", "{\"event_type\":\"message\",\"content\":\"담당자 홍길동 010-1234-5678 a@b.com 예산을 바꿔줘\"}")
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.message_id").isNumber())
				.andExpect(jsonPath("$.data.input_version_id").isNumber());
		assertThat(jdbcTemplate.queryForObject("SELECT input_json->>'budget_krw' FROM work_version "
				+ "WHERE session_id = 500 AND version_no = 1", String.class)).isEqualTo("120000");
		String content = jdbcTemplate.queryForObject("SELECT content FROM session_message WHERE session_id = 500 "
				+ "AND role = 'user'", String.class);
		assertThat(content).doesNotContain("홍길동", "010-1234-5678", "a@b.com");
	}

	@Test
	void AI가_설명만_주고_입력스냅샷을_주지_않으면_성공으로_저장하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		org.mockito.Mockito.doReturn(ApiResponse.ok(Map.of("parsed_input", Map.of("changed", List.of("budget_krw")))))
				.when(aiServerClient).post(anyString(), any(), anyString(), any());
		postEvent("bad-agent", "{\"event_type\":\"message\",\"content\":\"예산 바꿔줘\"}")
				.andExpect(status().isBadGateway());
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class))
				.isZero();
	}

	@Test
	void AI_입력스냅샷의_계약위반은_400이_아닌_502이고_저장하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		List<Map<String, Object>> inputs = List.of(
				Map.of("budget_krw", -1), Map.of("planning_days", 1.5),
				Map.of("max_delivery_count", 0), Map.of("budget_krw", "돈"),
				Map.of("items", List.of(Map.of("base_unit", "L"))),
				Map.of("items", List.of(Map.of("safety_stock", 10, "max_end_inventory", 5))));
		for (int i = 0; i < inputs.size(); i++) {
			org.mockito.Mockito.doReturn(ApiResponse.ok(Map.of("parsed_input", Map.of("input", inputs.get(i)))))
					.when(aiServerClient).post(anyString(), any(), anyString(), any());
			postEvent("invalid-ai-snapshot-" + i, "{\"event_type\":\"message\",\"content\":\"입력 변경\"}")
					.andExpect(status().isBadGateway())
					.andExpect(jsonPath("$.status").value("error"));
		}
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class)).isZero();
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM session_message WHERE session_id = 500", Integer.class)).isZero();
	}

	@Test
	void 지난_폼_기준버전으로_최신조건을_덮어쓰지_않는다() throws Exception {
		insertSession(500, 10, 2);
		insertVersion(1001, 500, 1, true);
		insertVersion(1002, 500, 2, false);
		postEvent("stale-form", "{\"event_type\":\"form\",\"base_version_id\":1001,\"form_input\":{\"budget_krw\":1}}")
				.andExpect(status().isBadRequest());
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class))
				.isEqualTo(2);
	}

	@Test
	void 같은_요청키의_다른_입력은_400으로_거부한다() throws Exception {
		insertSession(500, 10, 1);
		postEvent("key-reuse", formBody(100000)).andExpect(status().isOk());
		postEvent("key-reuse", formBody(200000)).andExpect(status().isBadRequest());
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class))
				.isEqualTo(1);
	}

	@Test
	void 변경없는_폼도_요청키를_기억하고_나중_재전송이_조건을_되돌리지_않는다() throws Exception {
		insertSession(500, 10, 1);
		postEvent("initial", formBody(100000)).andExpect(status().isOk());
		String first = postEvent("unchanged", formBody(100000)).andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString();
		postEvent("changed", formBody(200000)).andExpect(status().isOk());
		String replay = postEvent("unchanged", formBody(100000)).andExpect(status().isOk())
				.andReturn().getResponse().getContentAsString();
		assertThat(com.jayway.jsonpath.JsonPath.<Object>read(replay, "$")).isEqualTo(com.jayway.jsonpath.JsonPath.<Object>read(first, "$"));
		assertThat(jdbcTemplate.queryForObject("SELECT current_version FROM work_session WHERE session_id = 500", Integer.class))
				.isEqualTo(2);
	}

	@Test
	void 같은_요청키가_동시에_도착해도_버전과_응답을_한번만_만든다() throws Exception {
		insertSession(500, 10, 1);
		var barrier = new java.util.concurrent.CyclicBarrier(2);
		try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
			java.util.concurrent.Callable<String> call = () -> {
				barrier.await(10, java.util.concurrent.TimeUnit.SECONDS);
				return postEvent("parallel-same", formBody(100000)).andExpect(status().isOk())
						.andReturn().getResponse().getContentAsString();
			};
			var first = pool.submit(call);
			var second = pool.submit(call);
			assertThat(com.jayway.jsonpath.JsonPath.<Object>read(first.get(10, java.util.concurrent.TimeUnit.SECONDS), "$"))
					.isEqualTo(com.jayway.jsonpath.JsonPath.<Object>read(second.get(10, java.util.concurrent.TimeUnit.SECONDS), "$"));
		}
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class)).isEqualTo(1);
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM session_message WHERE session_id = 500", Integer.class)).isEqualTo(2);
	}

	@Test
	void 서로_다른_동시_이벤트도_버전번호가_충돌하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		var barrier = new java.util.concurrent.CyclicBarrier(2);
		try (var pool = java.util.concurrent.Executors.newVirtualThreadPerTaskExecutor()) {
			var first = pool.submit(() -> {
				barrier.await(10, java.util.concurrent.TimeUnit.SECONDS);
				return postEvent("parallel-A", formBody(100000)).andExpect(status().isOk()).andReturn();
			});
			var second = pool.submit(() -> {
				barrier.await(10, java.util.concurrent.TimeUnit.SECONDS);
				return postEvent("parallel-B", formBody(200000)).andExpect(status().isOk()).andReturn();
			});
			first.get(10, java.util.concurrent.TimeUnit.SECONDS);
			second.get(10, java.util.concurrent.TimeUnit.SECONDS);
		}
		assertThat(jdbcTemplate.queryForList("SELECT version_no FROM work_version WHERE session_id = 500 ORDER BY version_no", Integer.class))
				.containsExactly(1, 2);
	}

	@Test
	void 질문은_서버가_발급하고_답변후에는_재사용할수_없다() throws Exception {
		insertSession(500, 10, 1);
		org.mockito.Mockito.doReturn(ApiResponse.needsInput(Map.of("question_id", "untrusted-ai-id", "missing_fields",
				List.of(Map.of("path", "budget_krw", "label", "예산"))), "예산을 알려 주세요."))
				.when(aiServerClient).post(anyString(), any(), anyString(), any());
		String body = postEvent("ask", "{\"event_type\":\"message\",\"content\":\"매입 준비\"}")
				.andExpect(status().isOk()).andExpect(jsonPath("$.status").value("needs_input"))
				.andReturn().getResponse().getContentAsString();
		String questionId = com.jayway.jsonpath.JsonPath.read(body, "$.data.question_id");
		assertThat(questionId).startsWith("q_").isNotEqualTo("untrusted-ai-id");
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class)).isZero();
		org.mockito.Mockito.doReturn(agentInput(100000)).when(aiServerClient).post(anyString(), any(), anyString(), any());
		String reply = "{\"event_type\":\"question_reply\",\"question_id\":\"" + questionId + "\",\"answer\":\"10만원\"}";
		postEvent("answer", reply).andExpect(status().isOk());
		postEvent("answer", reply).andExpect(status().isOk()); // 동일 요청의 재시도는 원 응답
		postEvent("answer-again", reply).andExpect(status().isBadRequest());
	}

	@Test
	void 발급하지_않은_질문에는_AI를_호출하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		postEvent("forged-question", "{\"event_type\":\"question_reply\",\"question_id\":\"fake\",\"answer\":\"10만원\"}")
				.andExpect(status().isBadRequest());
		org.mockito.Mockito.verify(aiServerClient, org.mockito.Mockito.never()).post(anyString(), any(), anyString(), any());
	}

	@Test
	void AI를_기다리는동안_입력이_바뀌면_해석결과를_저장하지_않는다() throws Exception {
		insertSession(500, 10, 1);
		insertVersion(1001, 500, 1, false);
		org.mockito.Mockito.doAnswer(call -> {
			insertVersion(1002, 500, 2, false);
			jdbcTemplate.update("UPDATE work_session SET current_version = 2 WHERE session_id = 500");
			return agentInput(100000);
		}).when(aiServerClient).post(anyString(), any(), anyString(), any());
		postEvent("outdated-agent", "{\"event_type\":\"message\",\"content\":\"예산 변경\"}")
				.andExpect(status().isBadRequest());
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM session_message WHERE session_id = 500", Integer.class)).isZero();
	}

	@Test
	void 폼의_중첩_개인정보도_입력스냅샷과_응답에서_가린다() throws Exception {
		insertSession(500, 10, 0);
		String body = "{\"event_type\":\"form\",\"form_input\":{\"supplier\":{\"person_name\":\"홍길동\",\"contact\":\"010-1234-5678 a@b.com\"},\"budget_krw\":100000}}";
		String response = postEvent("private-form", body).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.version_no").value(1)).andReturn().getResponse().getContentAsString();
		assertThat(response).doesNotContain("홍길동", "010-1234-5678", "a@b.com");
		assertThat(jdbcTemplate.queryForObject("SELECT input_json::text FROM work_version WHERE session_id = 500", String.class))
				.doesNotContain("홍길동", "010-1234-5678", "a@b.com");
	}

	@Test
	void 잡담과_설명만인_명시적_NO_CHANGE는_대화만_저장한다() throws Exception {
		insertSession(500, 10, 1);
		org.mockito.Mockito.doReturn(ApiResponse.ok(Map.of("detail_status", "NO_CHANGE")))
				.when(aiServerClient).post(anyString(), any(), anyString(), any());
		postEvent("smalltalk", "{\"event_type\":\"message\",\"content\":\"안녕하세요\"}")
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.input_version_id").value(nullValue()));
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class)).isZero();
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM session_message WHERE session_id = 500", Integer.class)).isEqualTo(2);
	}

	@Test
	void 같은_기준버전이어도_새_질문이_발급되면_지난_질문을_거부한다() throws Exception {
		insertSession(500, 10, 1);
		org.mockito.Mockito.doReturn(ApiResponse.needsInput(Map.of("missing_fields", List.of(Map.of("path", "budget_krw"))), "예산?"))
				.when(aiServerClient).post(anyString(), any(), anyString(), any());
		String first = postEvent("question-A", "{\"event_type\":\"message\",\"content\":\"매입\"}")
				.andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
		String questionId = com.jayway.jsonpath.JsonPath.read(first, "$.data.question_id");
		postEvent("question-B", "{\"event_type\":\"message\",\"content\":\"다시 질문\"}").andExpect(status().isOk());
		postEvent("old-question", "{\"event_type\":\"question_reply\",\"question_id\":\"" + questionId + "\",\"answer\":\"10만원\"}")
				.andExpect(status().isBadRequest());
	}

	@Test
	void 폼의_음수_잘못된_단위_소수_기간을_거부한다() throws Exception {
		insertSession(500, 10, 1);
		String[] inputs = {"{\"budget_krw\":-1}", "{\"planning_days\":1.5}",
				"{\"max_delivery_count\":0}", "{\"budget_krw\":\"돈\"}",
				"{\"items\":[{\"base_unit\":\"L\"}]}",
				"{\"items\":[{\"safety_stock\":10,\"max_end_inventory\":5}]}"};
		for (int i = 0; i < inputs.length; i++) {
			postEvent("invalid-form-" + i, "{\"event_type\":\"form\",\"form_input\":" + inputs[i] + "}")
					.andExpect(status().isBadRequest());
		}
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class)).isZero();
	}

	@Test
	void 모르는_재고는_null로_유지하고_0으로_만들지_않는다() throws Exception {
		insertSession(500, 10, 1);
		postEvent("unknown-inventory", "{\"event_type\":\"form\",\"form_input\":{\"usable_inventory\":null,\"budget_krw\":100000}}")
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("needs_input"))
				.andExpect(jsonPath("$.data.draft_input.usable_inventory").value(nullValue()))
				.andExpect(jsonPath("$.data.missing_fields[0].path").value("usable_inventory"));
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_version WHERE session_id = 500", Integer.class)).isZero();
	}

	private ApiResponse<Map<String, Object>> agentInput(int budget) {
		return ApiResponse.ok(Map.of("parsed_input", Map.of("input", Map.of("budget_krw", budget),
				"changed", List.of("budget_krw")), "assumptions", List.of(), "warnings", List.of()));
	}

	private String formBody(int budget) {
		return "{\"event_type\":\"form\",\"form_input\":{\"budget_krw\":" + budget + "}}";
	}

	private org.springframework.test.web.servlet.ResultActions postEvent(String key, String body) throws Exception {
		return mockMvc.perform(post("/api/v1/work-sessions/500/events").header("X-Request-Key", key)
				.contentType(MediaType.APPLICATION_JSON).content(body));
	}

	/** 목록 시나리오용 업무를 updated_at까지 지정해 넣는다(정렬·커서 검증). */
	private void insertListSession(long sessionId, long storeId, String featureType, String updatedAt) {
		jdbcTemplate.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title,
				                          current_version, step, created_at, updated_at)
				VALUES (?, ?, ?, 'agent', '목록 업무', 1, 'input', ?, ?)
				""", sessionId, storeId, featureType, java.time.OffsetDateTime.parse(updatedAt),
				java.time.OffsetDateTime.parse(updatedAt));
	}

	/** 조회 시나리오용 업무를 실제 DB에 넣는다. */
	private void insertSession(long sessionId, long storeId, int currentVersion) {
		jdbcTemplate.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version)
				VALUES (?, ?, 'purchase', 'agent', '테스트 업무', ?)
				""", sessionId, storeId, currentVersion);
	}

	/** 확인자·확인 시각은 V1의 쌍 제약에 맞춰 함께 넣거나 함께 비운다. */
	private void insertVersion(long versionId, long sessionId, int versionNo, boolean confirmed) {
		jdbcTemplate.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json,
				    input_confirmed_by, input_confirmed_at)
				VALUES (?, ?, ?, 'v1', '{}'::jsonb, ?, ?)
				""", versionId, sessionId, versionNo, confirmed ? "demo-owner" : null,
				confirmed ? java.time.OffsetDateTime.parse("2026-11-13T10:00:00+09:00") : null);
	}

	/** 결과 시각과 ID를 고정해 최신 결과 정렬·버전 분리 동작을 검증한다. */
	private void insertResult(long resultId, long versionId, long sessionId, int versionNo, String createdAt) {
		jdbcTemplate.update("""
				INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no,
				    feature_type, request_key, response_status, summary_json, created_at)
				VALUES (?, ?, ?, 10, ?, 'purchase', ?, 'ok', '{}'::jsonb, ?)
				""", resultId, versionId, sessionId, versionNo, "result-" + resultId,
				java.time.OffsetDateTime.parse(createdAt));
	}

}
