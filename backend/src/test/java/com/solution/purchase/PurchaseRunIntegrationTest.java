package com.solution.purchase;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.verifyNoInteractions;
import com.solution.common.exception.ApiException;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;

import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
import com.solution.purchase.service.PurchaseService;
import com.solution.session.service.WorkDeletionService;

/**
 * 구매안 계산 실행을 실제 DB로 확인한다. FastAPI 호출만 가짜로 두고, 저장·잠금은 진짜 PostgreSQL에서 돈다.
 * Docker가 없으면 실패 대신 건너뛴다. CI에는 Docker가 있어 항상 돈다.
 */
@SpringBootTest(properties = "demo.owner-key=demo-owner")
@Testcontainers(disabledWithoutDocker = true)
class PurchaseRunIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired
	private PurchaseService purchaseService;
	@Autowired
	private WorkDeletionService deletion;

	@Autowired
	private JdbcTemplate jdbcTemplate;

	@MockitoBean
	private AiServerClient aiServerClient;

	@BeforeEach
	void seed() {
		jdbcTemplate.update("DELETE FROM work_confirmation");
		jdbcTemplate.update("DELETE FROM work_result");
		jdbcTemplate.update("DELETE FROM work_version");
		jdbcTemplate.update("DELETE FROM work_session");
		jdbcTemplate.update("DELETE FROM store");
		jdbcTemplate.update("""
				INSERT INTO store (store_id, owner_key, store_name, open_time, close_time)
				VALUES (10, 'demo-owner', '데모 카페', '07:00:00', '19:00:00')
				""");
		jdbcTemplate.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title, current_version)
				VALUES (100, 10, 'purchase', 'form', '이번 주 매입', 1)
				""");
		jdbcTemplate.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, input_json,
				                          input_confirmed_by, input_confirmed_at)
				VALUES (1001, 100, 1, 'purchase-v1', '{"budget_krw": 200000}'::jsonb, 'demo-owner', now())
				""");
	}

	@Test
	void 삭제된_업무는_계산을_시작하지_않는다() {
		jdbcTemplate.update("UPDATE work_session SET deleted_at=now() WHERE session_id=100");
		assertThatThrownBy(() -> purchaseService.run(100, 1001, "deleted"))
				.isInstanceOfSatisfying(ApiException.class, e -> assertThat(e.getDetailCode()).isEqualTo("SESSION_NOT_FOUND"));
		verifyNoInteractions(aiServerClient);
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_result", Integer.class)).isZero();
	}

	@Test
	@SuppressWarnings("unchecked")
	void 계산_중_삭제된_업무에는_결과를_저장하거나_단계를_갱신하지_않는다() {
		given(aiServerClient.post(eq("/tools/purchase"), any(), anyString(), any(ParameterizedTypeReference.class)))
				.willAnswer(call -> {
					deletion.deleteSession(100);
					return ApiResponse.ok(Map.of("detail_status", "OPTIMAL", "summary", Map.of(), "detail", Map.of()));
				});
		assertThatThrownBy(() -> purchaseService.run(100, 1001, "deleted-during-tool"))
				.hasFieldOrPropertyWithValue("detailCode", "SESSION_NOT_FOUND");
		assertThat(jdbcTemplate.queryForObject("SELECT count(*) FROM work_result", Integer.class)).isZero();
		assertThat(jdbcTemplate.queryForObject("SELECT step FROM work_session WHERE session_id=100", String.class)).isEqualTo("input");
	}

	@Test
	@SuppressWarnings("unchecked")
	void 같은_요청키가_동시에_두_번_와도_결과는_하나만_저장된다() throws Exception {
		Map<String, Object> data = Map.of(
				"detail_status", "OPTIMAL",
				"summary", Map.of("choices", List.of(Map.of("choice_key", "purchase_1", "total_krw", 120400))),
				"detail", Map.of("buy_needs", List.of()));
		// 두 요청이 모두 "아직 저장된 결과 없음"을 본 뒤 계산에 들어가도록 계산을 조금 늦춘다.
		given(aiServerClient.post(eq("/tools/purchase"), any(), anyString(), any(ParameterizedTypeReference.class)))
				.willAnswer(invocation -> {
					Thread.sleep(300);
					return ApiResponse.ok(data);
				});

		ExecutorService pool = Executors.newFixedThreadPool(2);
		CountDownLatch start = new CountDownLatch(1);
		try {
			Future<ApiResponse<Map<String, Object>>> first = pool.submit(() -> {
				start.await();
				return purchaseService.run(100, 1001, "same-key");
			});
			Future<ApiResponse<Map<String, Object>>> second = pool.submit(() -> {
				start.await();
				return purchaseService.run(100, 1001, "same-key");
			});
			start.countDown();

			Object firstId = first.get().data().get("result_id");
			Object secondId = second.get().data().get("result_id");

			Integer saved = jdbcTemplate.queryForObject(
					"SELECT count(*) FROM work_result WHERE input_version_id = 1001 AND request_key = 'same-key'",
					Integer.class);
			assertThat(saved).isEqualTo(1);
			assertThat(secondId).isEqualTo(firstId);
		}
		finally {
			pool.shutdownNow();
		}
	}

	@Test
	@SuppressWarnings("unchecked")
	void 다른_요청키는_각각_저장된다() {
		given(aiServerClient.post(eq("/tools/purchase"), any(), anyString(), any(ParameterizedTypeReference.class)))
				.willReturn(ApiResponse.ok(Map.of("detail_status", "OPTIMAL", "summary", Map.of(), "detail", Map.of())));

		purchaseService.run(100, 1001, "key-a");
		purchaseService.run(100, 1001, "key-b");

		Integer saved = jdbcTemplate.queryForObject("SELECT count(*) FROM work_result WHERE input_version_id = 1001",
				Integer.class);
		assertThat(saved).isEqualTo(2);
	}
}
