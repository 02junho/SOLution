package com.solution.common.demo;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.verify;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.purchase.service.PurchaseService;

/**
 * DEMO_SEED=true일 때 시연용 기본 데이터가 실제 DB에 들어가고, 그 데이터로 구매안 계산 실행이 되는지 확인한다.
 * FastAPI 호출만 가짜다. 실제 FastAPI까지 끝까지 부르는 확인은 CI의 compose 단계에서 한다.
 */
@SpringBootTest(properties = {"demo.seed=true", "demo.owner-key=demo-owner"})
@Testcontainers(disabledWithoutDocker = true)
class DemoSeedIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@Autowired
	private DemoSeedRunner demoSeedRunner;

	@Autowired
	private PurchaseService purchaseService;

	@MockitoBean
	private AiServerClient aiServerClient;

	@Test
	void 서버가_뜰_때_시연용_매장과_구매_업무_3건이_들어간다() {
		assertThat(jdbcTemplate.queryForObject("SELECT owner_key FROM store WHERE store_id = 1", String.class))
				.isEqualTo("demo-owner");
		List<Long> sessions = jdbcTemplate.queryForList("""
				SELECT s.session_id FROM work_session s
				JOIN work_version v ON v.session_id = s.session_id AND v.version_no = s.current_version
				WHERE s.store_id = 1 AND s.feature_type = 'purchase' AND v.input_confirmed_at IS NOT NULL
				ORDER BY s.session_id
				""", Long.class);
		assertThat(sessions).containsExactly(1001L, 1002L, 1003L);
	}

	@Test
	void 여러_번_넣어도_그대로다() {
		Integer before = countRows();

		demoSeedRunner.run(null);
		demoSeedRunner.run(null);

		assertThat(countRows()).isEqualTo(before);
	}

	@Test
	@SuppressWarnings("unchecked")
	void 시연_업무로_바로_구매안_계산을_실행할_수_있다() {
		given(aiServerClient.post(eq("/tools/purchase"), any(), anyString(), any(ParameterizedTypeReference.class)))
				.willReturn(ApiResponse.ok(Map.of("detail_status", "OPTIMAL", "summary", Map.of(), "detail", Map.of())));

		ApiResponse<Map<String, Object>> response = purchaseService.run(1001, 100101, "demo-key");

		assertThat(response.status()).isEqualTo(ResponseStatus.OK);
		ArgumentCaptor<Object> body = ArgumentCaptor.forClass(Object.class);
		verify(aiServerClient).post(eq("/tools/purchase"), body.capture(), eq("demo-key"),
				any(ParameterizedTypeReference.class));
		Map<String, Object> sent = (Map<String, Object>) body.getValue();
		assertThat(sent).containsEntry("store_id", 1L).containsEntry("session_id", 1001L)
				.containsEntry("input_version_id", 100101L).containsEntry("budget_krw", 200000);
		assertThat((List<?>) sent.get("quotes")).hasSize(4);
	}

	private Integer countRows() {
		return jdbcTemplate.queryForObject("""
				SELECT (SELECT count(*) FROM store) + (SELECT count(*) FROM work_session)
				     + (SELECT count(*) FROM work_version)
				""", Integer.class);
	}
}
