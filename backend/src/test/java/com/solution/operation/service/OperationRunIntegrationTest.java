package com.solution.operation.service;

import com.solution.operation.service.simulation.SimulationService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;
import org.testcontainers.utility.DockerImageName;

import com.solution.common.client.AiServerClient;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.operation.dto.simulation.SimulationRequest;
import com.solution.operation.dto.simulation.SimulationResult;
import com.solution.operation.dto.StaffingPlan;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/** 실제 PostgreSQL 저장·권한·동시 재전송 검증. 도구만 합성 계약 응답으로 격리한다. */
@SpringBootTest(properties = "demo.owner-key=demo-owner")
@Testcontainers(disabledWithoutDocker = true)
@SuppressWarnings("unchecked")
class OperationRunIntegrationTest {

	@Container
	@ServiceConnection
	static final PostgreSQLContainer POSTGRES = new PostgreSQLContainer(
			DockerImageName.parse("pgvector/pgvector:pg16").asCompatibleSubstituteFor("postgres"));

	@Autowired
	private JdbcTemplate jdbc;
	@Autowired
	private ObjectMapper mapper;
	@Autowired
	private OperationResultService service;
	@MockitoBean
	private SimulationService simulation;
	@MockitoBean
	private AiServerClient client;

	@BeforeEach
	void seed() throws Exception {
		jdbc.execute("TRUNCATE store CASCADE");
		jdbc.update("""
				INSERT INTO store(store_id, owner_key, store_name, open_time, close_time)
				VALUES (510001, 'demo-owner', '합성 테스트 카페', '07:00', '19:00')
				""");
		jdbc.update("""
				INSERT INTO work_session(session_id, store_id, feature_type, input_method, title, current_version)
				VALUES (520001, 510001, 'operation', 'form', '합성 운영 비교', 1)
				""");
		jdbc.update("""
				INSERT INTO work_version(input_version_id, session_id, version_no, schema_version, input_json,
				 input_confirmed_by, input_confirmed_at)
				VALUES (530001, 520001, 1, 'operation.v1', ?::jsonb, 'demo-owner', now())
				""", Files.readString(Path.of("../data/demo/operation/input.json")));
		Map<String, Object> detail = OperationResultContract.map(
				OperationResultContract.map(read("preview.json").get("result")).get("detail"));
		when(client.post(eq("/tools/labor/schedule"), any(), anyString(),
				any(ParameterizedTypeReference.class)))
				.thenReturn(ApiResponse.ok(OperationResultContract.map(detail.get("schedule"))));
		when(client.post(eq("/tools/labor/cost"), any(), anyString(),
				any(ParameterizedTypeReference.class)))
				.thenReturn(ApiResponse.ok(OperationResultContract.map(read("expected_cost.json").get("data"))));
		stubSimulation(null);
	}

	private Map<String, Object> read(String name) throws Exception {
		return mapper.readValue(Files.readString(Path.of("../data/demo/operation", name)),
				new TypeReference<>() { });
	}

	private void stubSimulation(CyclicBarrier overlap) {
		when(simulation.compare(any(), anyString())).thenAnswer(call -> {
			SimulationRequest request = call.getArgument(0);
			if (overlap != null) {
				overlap.await(10, TimeUnit.SECONDS);
			}
			Map<String, Object> data = OperationResultContract.map(read("compare_response.json").get("data"));
			data.put("result_id", request.resultId());
			data.put("trace_refs", List.of());
			List<StaffingPlan> staffing = OperationResultContract.staffing(data.get("staffing"))
					.stream().map(StaffingPlan::fromConfirmedPlan).toList();
			return new SimulationResult(ApiResponse.ok(data), staffing, call.getArgument(1));
		});
	}

	@Test
	void concurrentRetryPersistsOneResultWithActualDatabaseLock() throws Exception {
		stubSimulation(new CyclicBarrier(2));
		try (var pool = Executors.newFixedThreadPool(2)) {
			var first = pool.submit(() -> service.run(520001, 530001, "same-key"));
			var second = pool.submit(() -> service.run(520001, 530001, "same-key"));
			Object firstId = first.get(20, TimeUnit.SECONDS).data().get("result_id");
			assertThat(second.get(20, TimeUnit.SECONDS).data().get("result_id")).isEqualTo(firstId);
			assertThat(jdbc.queryForObject("SELECT count(*) FROM work_result", Integer.class)).isEqualTo(1);
		}
	}

	@Test
	void readsActualParentOwnershipAndCurrentVersion() {
		long id = ((Number)service.run(520001, 530001, "read-key").data().get("result_id")).longValue();
		jdbc.update("UPDATE work_session SET current_version = 2 WHERE session_id = 520001");
		assertThat(service.result(id, "summary").data()).containsEntry("is_latest_version", false);
		jdbc.update("UPDATE store SET owner_key = 'another-owner' WHERE store_id = 510001");
		assertThatThrownBy(() -> service.result(id, "detail"))
				.isInstanceOfSatisfying(ApiException.class,
						error -> assertThat(error.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
	}
}
