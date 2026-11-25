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

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {"demo.owner-key=demo-owner", "demo.seed=false"})
@AutoConfigureMockMvc
@Testcontainers
class WorkMessageApiIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired private MockMvc mvc;
	@Autowired private JdbcTemplate jdbc;
	@LocalServerPort private int port;

	@BeforeEach
	void seed() {
		jdbc.update("DELETE FROM execution_log");
		jdbc.update("DELETE FROM session_message");
		jdbc.update("DELETE FROM work_confirmation");
		jdbc.update("DELETE FROM work_result");
		jdbc.update("DELETE FROM work_version");
		jdbc.update("DELETE FROM work_session");
		jdbc.update("DELETE FROM store");
		jdbc.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time)
				VALUES (10, 'demo-owner', '내 매장', '07:00', '19:00'), (20, 'other', '남의 매장', '07:00', '19:00')
				""");
		jdbc.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title)
				VALUES (500, 10, 'purchase', 'agent', '내 업무'), (600, 20, 'purchase', 'agent', '남의 업무'),
				       (700, 10, 'operation', 'form', '다른 내 업무')
				""");
		// 시각과 버전은 역순이며, 정렬 기준은 message_id뿐이다.
		jdbc.update("""
				INSERT INTO session_message (message_id, session_id, version_no, role, content, metadata_json, created_at)
				VALUES (50, 500, 1, 'tool', '계산', '{"warnings":["확인"]}', '2026-11-13T10:00:00Z'),
				       (10, 500, NULL, 'user', '안녕하세요', NULL, '2026-11-13T12:00:00Z'),
				       (30, 500, 2, 'assistant', '질문', '{"question":{"choices":["재고","총량"]},"answered":false}', '2026-11-13T11:00:00Z'),
				       (20, 600, 1, 'user', '남의 대화', NULL, now()),
				       (40, 700, 1, 'system', '다른 업무 대화', NULL, now())
				""");
	}

	@Test
	void 실제_HTTP로_대화와_메타데이터를_조회하고_업무를_수정하지_않는다() throws Exception {
		var before = jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500");
		try (HttpClient client = HttpClient.newHttpClient()) {
			var response = client.send(HttpRequest.newBuilder(URI.create(
					"http://localhost:" + port + "/api/v1/work-sessions/500/messages?size=2")).GET().build(),
					HttpResponse.BodyHandlers.ofString());
			assertThat(response.statusCode()).isEqualTo(200);
			assertThat(response.body()).contains("\"next_cursor\":\"30\"", "\"metadata_json\":{", "\"created_at\":")
					.doesNotContain("남의 대화", "다른 업무 대화");
		}
		assertThat(jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500")).isEqualTo(before);
	}

	@Test
	void 페이지를_이어_읽으면_누락_중복_없이_모든_버전과_역할을_반환한다() throws Exception {
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("size", "2"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.items.length()").value(2))
				.andExpect(jsonPath("$.data.items[0].message_id").value(10))
				.andExpect(jsonPath("$.data.items[0].version_no").value(nullValue()))
				.andExpect(jsonPath("$.data.items[0].metadata_json").value(nullValue()))
				.andExpect(jsonPath("$.data.items[1].message_id").value(30))
				.andExpect(jsonPath("$.data.items[1].role").value("assistant"))
				.andExpect(jsonPath("$.data.items[1].content").value("질문"))
				.andExpect(jsonPath("$.data.items[1].metadata_json.question.choices[0]").value("재고"))
				.andExpect(jsonPath("$.data.items[1].metadata_json.answered").value(false))
				.andExpect(jsonPath("$.data.next_cursor").value("30"));
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("cursor", "30").param("size", "2"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].message_id").value(50))
				.andExpect(jsonPath("$.data.items[0].role").value("tool"))
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
	}

	@Test
	void 정확히_페이지_크기만큼이면_다음_커서는_null() throws Exception {
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("size", "3"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(3))
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
	}

	@Test
	void 커서_메시지가_해당_업무에_없어도_그보다_큰_id부터_읽는다() throws Exception {
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("cursor", "20"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items[0].message_id").value(30));
	}

	@Test
	void 기본_50개_최대_100개를_적용한다() throws Exception {
		jdbc.update("DELETE FROM session_message WHERE session_id=500");
		jdbc.update("""
				INSERT INTO session_message (message_id, session_id, role, content)
				SELECT n, 500, 'user', '테스트' FROM generate_series(100, 204) n
				""");
		mvc.perform(get("/api/v1/work-sessions/500/messages"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(50))
				.andExpect(jsonPath("$.data.next_cursor").value("149"));
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("size", "100"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(100))
				.andExpect(jsonPath("$.data.next_cursor").value("199"));
	}

	@Test
	void 새로_추가된_메시지는_다음_페이지에서_읽는다() throws Exception {
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("size", "2"))
				.andExpect(jsonPath("$.data.next_cursor").value("30"));
		jdbc.update("INSERT INTO session_message (message_id, session_id, role, content) VALUES (90, 500, 'system', '추가')");
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("cursor", "30"))
				.andExpect(jsonPath("$.data.items.length()").value(2))
				.andExpect(jsonPath("$.data.items[1].message_id").value(90));
	}

	@Test
	void 빈_대화와_끝_커서는_빈_목록() throws Exception {
		jdbc.update("DELETE FROM session_message WHERE session_id=500");
		mvc.perform(get("/api/v1/work-sessions/500/messages"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items").isEmpty())
				.andExpect(jsonPath("$.data.next_cursor").value(nullValue()));
		mvc.perform(get("/api/v1/work-sessions/700/messages").param("cursor", "9223372036854775807"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items").isEmpty());
	}

	@ParameterizedTest
	@ValueSource(strings = {"600", "999999"})
	void 남의_업무와_없는_업무는_동일한_404(String id) throws Exception {
		mvc.perform(get("/api/v1/work-sessions/" + id + "/messages").param("cursor", "invalid"))
				.andExpect(status().isNotFound()).andExpect(jsonPath("$.status").value("error"))
				.andExpect(jsonPath("$.data.detail_code").value("SESSION_NOT_FOUND"))
				.andExpect(jsonPath("$.message").value("업무를 찾을 수 없습니다."));
	}

	@ParameterizedTest
	@ValueSource(strings = {"0", "-1", "101", "abc", "1.5", "2147483648"})
	void 잘못된_size는_400(String size) throws Exception {
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("size", size))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.status").value("error"));
	}

	@ParameterizedTest
	@ValueSource(strings = {"", "0", "-1", "abc", "1.5", "9223372036854775808", "1 OR 1=1"})
	void 잘못된_cursor는_400(String cursor) throws Exception {
		mvc.perform(get("/api/v1/work-sessions/500/messages").param("cursor", cursor))
				.andExpect(status().isBadRequest());
	}

	@ParameterizedTest
	@ValueSource(strings = {"abc", "9223372036854775808"})
	void 업무번호_변환오류는_400(String id) throws Exception {
		mvc.perform(get("/api/v1/work-sessions/" + id + "/messages")).andExpect(status().isBadRequest());
	}

	@Test
	void events로_저장된_폼_대화를_메타데이터와_함께_조회한다() throws Exception {
		mvc.perform(post("/api/v1/work-sessions/700/events").contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\":\"form\",\"form_input\":{\"planning_days\":7}}"))
				.andExpect(status().isOk());
		mvc.perform(get("/api/v1/work-sessions/700/messages").param("cursor", "40"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(2))
				.andExpect(jsonPath("$.data.items[0].role").value("user"))
				.andExpect(jsonPath("$.data.items[1].metadata_json.source").value("form"))
				.andExpect(jsonPath("$.data.items[1].metadata_json.response.status").value("ok"));
	}

	@Test
	void 남의_업무는_삭제할_수_없다() throws Exception {
		mvc.perform(delete("/api/v1/work-sessions/600")).andExpect(status().isNotFound());
		assertThat(jdbc.queryForObject("SELECT content FROM session_message WHERE message_id=20", String.class))
				.isEqualTo("남의 대화");
	}

	@Test
	void 업무_삭제는_이어하기와_문맥_및_대화_접근을_막고_기존_자료를_보존한다() throws Exception {
		mvc.perform(delete("/api/v1/work-sessions/500")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/work-sessions"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.items.length()").value(1))
				.andExpect(jsonPath("$.data.items[0].session_id").value(700));
		mvc.perform(get("/api/v1/work-sessions/500")).andExpect(status().isNotFound());
		mvc.perform(get("/api/v1/work-sessions/500/messages")).andExpect(status().isNotFound());
		assertThat(jdbc.queryForObject("SELECT count(*) FROM session_message WHERE session_id=500", Integer.class))
				.isEqualTo(3);
	}

	@Test
	void 계산_중에는_업무를_삭제하지_않는다() throws Exception {
		jdbc.update("UPDATE work_session SET step='running' WHERE session_id=500");
		mvc.perform(delete("/api/v1/work-sessions/500"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("SESSION_RUNNING"));
		assertThat(jdbc.queryForObject("SELECT deleted_at FROM work_session WHERE session_id=500", Object.class)).isNull();
	}

	@ParameterizedTest
	@ValueSource(strings = {"result", "review", "saved"})
	void running_단계가_아니어도_활성_계산이_남아_있으면_삭제_API를_차단한다(String step) throws Exception {
		jdbc.update("UPDATE work_session SET step=?, active_operation_runs=1 WHERE session_id=500", step);
		mvc.perform(delete("/api/v1/work-sessions/500"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.data.detail_code").value("SESSION_RUNNING"));
		assertThat(jdbc.queryForObject("SELECT content FROM session_message WHERE message_id=10", String.class)).isEqualTo("안녕하세요");
		jdbc.update("UPDATE work_session SET active_operation_runs=0 WHERE session_id=500");
		mvc.perform(delete("/api/v1/work-sessions/500")).andExpect(status().isOk());
	}

	@Test
	void 잘못된_삭제_경로는_500_대신_400이다() throws Exception {
		mvc.perform(delete("/api/v1/work-sessions/abc")).andExpect(status().isBadRequest());
	}
}
