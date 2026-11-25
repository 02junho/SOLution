package com.solution.session;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.verifyNoInteractions;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

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
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;
import com.solution.session.service.SessionRepository;

/** 실제 PostgreSQL·Flyway·HTTP로 입력 확인 및 계산 허용 경계를 검증한다. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = {"demo.owner-key=demo-owner", "demo.seed=false"})
@AutoConfigureMockMvc
@Testcontainers
class WorkVersionApiIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired private MockMvc mvc;
	@Autowired private JdbcTemplate jdbc;
	@Autowired private TransactionTemplate transactions;
	@org.springframework.test.context.bean.override.mockito.MockitoSpyBean private SessionRepository repository;
	@MockitoBean private AiServerClient ai;
	@LocalServerPort private int port;

	@BeforeEach
	void seed() {
		jdbc.update("DELETE FROM session_message");
		jdbc.update("DELETE FROM work_confirmation");
		jdbc.update("DELETE FROM work_result");
		jdbc.update("DELETE FROM work_version");
		jdbc.update("DELETE FROM work_session");
		jdbc.update("DELETE FROM store");
		jdbc.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time,
				    settings_version, profile_json) VALUES (10, 'demo-owner', '검증 매장', '07:00', '19:00', 1, '{}')
				""");
		jdbc.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version, step)
				VALUES (500, 10, 'purchase', 'form', '입력 확인 검증', 2, 'input')
				""");
		insertVersion(1001, 1);
		insertVersion(1002, 2);
	}

	@Test
	void 실제_HTTP로_서버_확인자와_시각을_저장한다() throws Exception {
		OffsetDateTime before = OffsetDateTime.now().minusSeconds(1);
		try (HttpClient client = HttpClient.newHttpClient()) {
			var response = client.send(HttpRequest.newBuilder(URI.create(
					"http://localhost:" + port + "/api/v1/work-versions/1002/confirm-input"))
					.header("Content-Type", "application/json")
					.POST(HttpRequest.BodyPublishers.ofString("{\"expected_version_no\":2}" )).build(),
					HttpResponse.BodyHandlers.ofString());
			assertThat(response.statusCode()).isEqualTo(200);
			assertThat(response.body()).contains("\"input_confirmed_by\":\"demo-owner\"",
					"\"version_no\":2", "\"step\":\"review\"", "입력을 확인했어요. 이제 계산할 수 있어요.");
		}
		assertThat(confirmedAt()).isBetween(before, OffsetDateTime.now().plusSeconds(1));
		mvc.perform(get("/api/v1/work-sessions/500"))
				.andExpect(jsonPath("$.data.input_confirmed").value(true))
				.andExpect(jsonPath("$.data.has_confirmation").value(false));
		assertThat(jdbc.queryForObject("SELECT count(*) FROM work_confirmation", Integer.class)).isZero();
		verifyNoInteractions(ai);
	}

	@Test
	void 운영_입력도_같은_확인_규칙을_따른다() throws Exception {
		jdbc.update("UPDATE work_session SET feature_type='operation' WHERE session_id=500");
		confirm(1002, "{\"expected_version_no\":2}").andExpect(status().isOk())
				.andExpect(jsonPath("$.data.step").value("review"));
		assertThat(confirmedAt()).isNotNull();
	}

	@Test
	void 이미_확인한_최신버전은_기존_확인값과_진행단계를_보존한다() throws Exception {
		confirm(1002, "{}").andExpect(status().isOk());
		var original = jdbc.queryForMap("SELECT * FROM work_version WHERE input_version_id=1002");
		jdbc.update("UPDATE work_session SET step='result' WHERE session_id=500");
		var session = jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500");
		confirm(1002, "{\"expected_version_no\":2}").andExpect(status().isOk())
				.andExpect(jsonPath("$.data.step").value("result"));
		assertThat(jdbc.queryForMap("SELECT * FROM work_version WHERE input_version_id=1002")).isEqualTo(original);
		assertThat(jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500")).isEqualTo(session);
	}

	@Test
	void 확인된_옛버전도_최신이_아니면_거절한다() throws Exception {
		jdbc.update("UPDATE work_version SET input_confirmed_by='demo-owner', input_confirmed_at=now() WHERE input_version_id=1001");
		confirm(1001, "{}").andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("STALE_VERSION"));
		assertThat(confirmedAt()).isNull();
	}

	@Test
	void 화면이_본_순번이_다르면_거절한다() throws Exception {
		confirm(1002, "{\"expected_version_no\":1}").andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("STALE_VERSION"))
				.andExpect(jsonPath("$.message").value("조건이 바뀌었어요. 최신 입력을 다시 확인해 주세요."));
		assertThat(confirmedAt()).isNull();
	}

	@Test
	void 남의_버전은_오래된_순번을_보내도_404로_숨긴다() throws Exception {
		jdbc.update("UPDATE store SET owner_key='other-owner' WHERE store_id=10");
		confirm(1001, "{\"expected_version_no\":9}").andExpect(status().isNotFound())
				.andExpect(jsonPath("$.data.detail_code").value("VERSION_NOT_FOUND"))
				.andExpect(jsonPath("$.message").value("입력 버전을 찾을 수 없습니다."));
		assertThat(confirmedAt()).isNull();
	}

    @Test
    void 삭제된_업무의_입력_확인은_404이며_확인값과_단계는_유지한다() throws Exception {
        jdbc.update("UPDATE work_session SET deleted_at=now() WHERE session_id=500");
        var before = jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500");
        confirm(1002, "{}").andExpect(status().isNotFound())
            .andExpect(jsonPath("$.data.detail_code").value("VERSION_NOT_FOUND"));
        assertThat(confirmedAt()).isNull();
        assertThat(jdbc.queryForObject("SELECT input_confirmed_by FROM work_version WHERE input_version_id=1002", String.class)).isNull();
        assertThat(jdbc.queryForMap("SELECT * FROM work_session WHERE session_id=500")).isEqualTo(before);
    }

    @Test
    void 조회_직후_삭제되어도_세션_잠금_뒤_재검사에서_입력_확인을_차단한다() throws Exception {
        org.mockito.Mockito.doAnswer(call -> {
            var deletion = new TransactionTemplate(transactions.getTransactionManager());
            deletion.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
            deletion.executeWithoutResult(status -> jdbc.update("UPDATE work_session SET deleted_at=now() WHERE session_id=500"));
            return call.callRealMethod();
        }).when(repository).lockSession(500);
        confirm(1002, "{}").andExpect(status().isNotFound())
            .andExpect(jsonPath("$.data.detail_code").value("VERSION_NOT_FOUND"));
        assertThat(confirmedAt()).isNull();
        assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=500", String.class)).isEqualTo("input");
    }

	@Test
	void 없는_버전은_404() throws Exception {
		confirm(9999, "{}").andExpect(status().isNotFound())
				.andExpect(jsonPath("$.data.detail_code").value("VERSION_NOT_FOUND"));
	}

	@Test
	void 본문_없이도_최신_입력을_확인한다() throws Exception {
		mvc.perform(post("/api/v1/work-versions/1002/confirm-input")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.session_id").value(500))
				.andExpect(jsonPath("$.data.input_version_id").value(1002))
				.andExpect(jsonPath("$.data.step").value("review"));
	}

	@ParameterizedTest
	@ValueSource(strings = {"{\"expected_version_no\":0}", "{\"expected_version_no\":-1}", "{broken"})
	void 잘못된_본문은_400(String body) throws Exception {
		confirm(1002, body).andExpect(status().isBadRequest());
		assertThat(confirmedAt()).isNull();
	}

	@ParameterizedTest
	@ValueSource(strings = {"abc", "9223372036854775808"})
	void 경로_숫자_변환_오류는_400(String id) throws Exception {
		mvc.perform(post("/api/v1/work-versions/" + id + "/confirm-input").contentType(MediaType.APPLICATION_JSON)
				.content("{}")).andExpect(status().isBadRequest());
	}

	@Test
	void 클라이언트의_확인자와_시각을_신뢰하지_않는다() throws Exception {
		confirm(1002, "{\"expected_version_no\":2,\"input_confirmed_by\":\"attacker\","
				+ "\"input_confirmed_at\":\"2000-01-01T00:00:00Z\"}").andExpect(status().isOk())
				.andExpect(jsonPath("$.data.input_confirmed_by").value("demo-owner"));
		assertThat(jdbc.queryForObject("SELECT input_confirmed_by FROM work_version WHERE input_version_id=1002", String.class))
				.isEqualTo("demo-owner");
		assertThat(confirmedAt()).isAfter(OffsetDateTime.now().minusMinutes(1));
	}

	@Test
	void 새_폼_버전은_다시_확인해야_한다() throws Exception {
		confirm(1002, "{}").andExpect(status().isOk());
		mvc.perform(post("/api/v1/work-sessions/500/events").contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\":\"form\",\"form_input\":{\"budget_krw\":120000}}"))
				.andExpect(status().isOk()).andExpect(jsonPath("$.data.version_no").value(3));
		mvc.perform(get("/api/v1/work-sessions/500")).andExpect(jsonPath("$.data.input_confirmed").value(false));
		confirm(1002, "{}").andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("STALE_VERSION"));
	}

	@Test
	void 입력_확인_전에는_계산을_차단하고_확인_후에는_허용한다() throws Exception {
		mvc.perform(post("/api/v1/purchase/sessions/500/results").contentType(MediaType.APPLICATION_JSON)
				.content("{\"input_version_id\":1002}")).andExpect(status().isBadRequest());
		verifyNoInteractions(ai);
		confirm(1002, "{}").andExpect(status().isOk());
		given(ai.post(anyString(), any(), anyString(), any())).willReturn(ApiResponse.ok(
				Map.of("summary", Map.of("choices", java.util.List.of()), "detail", Map.of())));
		mvc.perform(post("/api/v1/purchase/sessions/500/results").contentType(MediaType.APPLICATION_JSON)
				.content("{\"input_version_id\":1002}")).andExpect(status().isOk());
		assertThat(jdbc.queryForObject("SELECT count(*) FROM work_result", Integer.class)).isEqualTo(1);
	}

	@Test
	void 동시에_확인해도_동일한_시각을_돌려준다() throws Exception {
		try (HttpClient client = HttpClient.newHttpClient()) {
			var req = HttpRequest.newBuilder(URI.create("http://localhost:" + port
					+ "/api/v1/work-versions/1002/confirm-input")).POST(HttpRequest.BodyPublishers.noBody()).build();
			var first = client.sendAsync(req, HttpResponse.BodyHandlers.ofString());
			var second = client.sendAsync(req, HttpResponse.BodyHandlers.ofString());
			var a = first.get(10, TimeUnit.SECONDS);
			var b = second.get(10, TimeUnit.SECONDS);
			assertThat(a.statusCode()).isEqualTo(200);
			assertThat(b.statusCode()).isEqualTo(200);
			assertThat(a.body()).isEqualTo(b.body());
		}
	}

	@Test
	void 버전_생성과_경합하면_잠금_후_최신성을_다시_검사한다() throws Exception {
		CountDownLatch started = new CountDownLatch(1);
		@SuppressWarnings("unchecked")
		CompletableFuture<Integer>[] pending = new CompletableFuture[1];
		transactions.executeWithoutResult(tx -> {
			repository.lockSession(500);
			pending[0] = CompletableFuture.supplyAsync(() -> {
				started.countDown();
				try {
					return confirm(1002, "{}").andReturn().getResponse().getStatus();
				}
				catch (Exception e) { throw new RuntimeException(e); }
			});
			try {
				assertThat(started.await(5, TimeUnit.SECONDS)).isTrue();
				assertThatThrownBy(() -> pending[0].get(200, TimeUnit.MILLISECONDS)).isInstanceOf(TimeoutException.class);
			}
			catch (InterruptedException e) { throw new RuntimeException(e); }
			insertVersion(1003, 3);
			repository.updateSessionProgress(500, 3, "review");
		});
		assertThat(pending[0].get(10, TimeUnit.SECONDS)).isEqualTo(400);
		assertThat(confirmedAt()).isNull();
	}

	private void insertVersion(long id, int version) {
		jdbc.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json)
				VALUES (?, 500, ?, 'purchase.v1', '{"budget_krw":200000}')
				""", id, version);
	}

	private OffsetDateTime confirmedAt() {
		return jdbc.queryForObject("SELECT input_confirmed_at FROM work_version WHERE input_version_id=1002",
				OffsetDateTime.class);
	}

	private ResultActions confirm(long id, String body) throws Exception {
		return mvc.perform(post("/api/v1/work-versions/" + id + "/confirm-input")
				.contentType(MediaType.APPLICATION_JSON).content(body));
	}
}
