package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
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
@SpringBootTest(properties = "demo.owner-key=demo-owner")
@AutoConfigureMockMvc
@Testcontainers
class WorkSessionApiIntegrationTest {

	// V1 마이그레이션의 vector 확장을 지원하도록 Compose와 같은 DB 이미지를 사용한다.
	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	/** 매 테스트 전에 깨끗이 비우고, 시연 사용자(demo-owner) 소유 매장과 남의 매장을 하나씩 넣는다. */
	@BeforeEach
	void seed() {
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
