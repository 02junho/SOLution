package com.solution.explain;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;

/**
 * 결과 설명 API 통합 테스트. 작성: 신준호
 *
 * <p>실제 DB에 매장·업무·입력 버전·결과를 넣고 FastAPI만 가짜로 둔다. 실제 결과→버전→업무→매장 경로로
 * 권한을 확인하는지, 지운 업무의 결과는 없는 것으로 보는지 확인한다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
		properties = "demo.owner-key=demo-owner")
@AutoConfigureMockMvc
@Testcontainers
class ResultExplanationApiIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired
	private MockMvc mockMvc;

	@Autowired
	private JdbcTemplate jdbc;

	@MockitoBean
	private AiServerClient aiServerClient;

	@BeforeEach
	@SuppressWarnings("unchecked")
	void seed() {
		for (String table : List.of("work_confirmation", "retired_confirmation_key", "calculation_run", "session_message",
				"work_result", "work_version", "work_session", "store")) {
			jdbc.update("DELETE FROM " + table);
		}
		jdbc.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time)
				VALUES (10, 'demo-owner', '데모 카페', '07:00:00', '19:00:00'),
				       (20, 'someone-else', '남의 카페', '07:00:00', '19:00:00')
				""");
		for (long[] row : new long[][] {{100, 10}, {200, 20}}) {
			jdbc.update("""
					INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version)
					VALUES (?, ?, 'purchase', 'form', '매입', 1)
					""", row[0], row[1]);
			jdbc.update("""
					INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json)
					VALUES (?, ?, 1, 'purchase.v1', '{}'::jsonb)
					""", row[0] + 1, row[0]);
			jdbc.update("""
					INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no, feature_type,
					                         request_key, response_status, detail_status, summary_json)
					VALUES (?, ?, ?, ?, 1, 'purchase', 'k', 'ok', 'OPTIMAL',
					        '{"choices":[{"choice_key":"purchase_1","label":"총비용 최소","total_krw":113280,
					          "delivery_count":2,"supplier_totals":[{"supplier_name":"원두 로스터리 다"}]}],
					          "warnings":[],"assumptions":[]}'::jsonb)
					""", row[0] + 2, row[0] + 1, row[0], row[1]);
		}
		given(aiServerClient.post(eq("/agent/explain"), any(), anyString(), any(ParameterizedTypeReference.class)))
				.willReturn(ApiResponse.ok(Map.of("detail_status", "EXPLAINED", "source", "template",
						"explanation", Map.of("headline", "총비용 최소: 113,280원.",
								"per_choice", List.of(Map.of("choice_key", "purchase_1", "text", "총비용 최소 · 배송 2회 · 113,280원")),
								"warnings_echo", List.of(), "caveats", List.of()))));
	}

	@Test
	void 내_결과면_설명을_돌려준다() throws Exception {
		mockMvc.perform(post("/api/v1/work-results/102/explanation"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.source").value("template"))
				.andExpect(jsonPath("$.data.explanation.per_choice[0].choice_key").value("purchase_1"));
	}

	@Test
	void 남의_결과나_지운_업무의_결과는_404() throws Exception {
		mockMvc.perform(post("/api/v1/work-results/202/explanation")).andExpect(status().isNotFound());
		jdbc.update("UPDATE work_session SET deleted_at = now() WHERE session_id = 100");
		mockMvc.perform(post("/api/v1/work-results/102/explanation")).andExpect(status().isNotFound());
	}
}
