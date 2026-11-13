package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
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
 * 업무 세션 시작 API의 통합 테스트.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>테스트가 돌 때 Testcontainers가 임시 PostgreSQL을 Docker로 띄우고, Flyway가 V1 스키마를 만든 뒤,
 * 실제 서버 문맥(Spring) + 실제 DB로 API를 호출한다. 즉 컨트롤러·검증·서비스·SQL·DB INSERT까지 끝까지 확인한다.
 * (Docker가 떠 있어야 실행된다. 단위 테스트와 달리 가짜 서비스를 쓰지 않는다.)
 */
@SpringBootTest(properties = "demo.owner-key=demo-owner")
@AutoConfigureMockMvc
@Testcontainers
class WorkSessionApiIntegrationTest {

	@Container
	@ServiceConnection
	static PostgreSQLContainer postgres = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	/** 매 테스트 전에 깨끗이 비우고, 시연 사용자(demo-owner) 소유 매장과 남의 매장을 하나씩 넣는다. */
	@BeforeEach
	void seed() {
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

		// 실제로 work_session 테이블에 한 줄이 들어갔는지 DB에서 직접 확인한다.
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
}
