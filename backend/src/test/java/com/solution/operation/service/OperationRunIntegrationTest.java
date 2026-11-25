package com.solution.operation.service;

import com.solution.operation.service.simulation.SimulationService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.Future;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoSpyBean;
import static org.mockito.Mockito.verifyNoInteractions;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;
import com.solution.session.service.WorkDeletionService;
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
	private PlatformTransactionManager transactions;
	@MockitoSpyBean
	private OperationResultRepository repository;
	@MockitoSpyBean
	private com.solution.session.service.SessionRepository sessions;
	@Autowired
	private com.solution.session.service.CalculationRuns runs;
	@Autowired
	private ObjectMapper mapper;
	@Autowired
	private OperationResultService service;
	@Autowired
	private WorkDeletionService deletion;
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
		// 이미 스텁된 메서드를 when(...)으로 다시 부르면 앞 스텁이 null 인자로 실행되므로 doAnswer로 바꾼다.
		doAnswer(call -> {
			SimulationRequest request = call.getArgument(0);
			if (overlap != null) {
				overlap.await(10, TimeUnit.SECONDS);
			}
			return simulationResponse(request, call.getArgument(1));
		}).when(simulation).compare(any(), anyString());
	}

	private SimulationResult simulationResponse(SimulationRequest request, String key) throws Exception {
		Map<String, Object> data = OperationResultContract.map(read("compare_response.json").get("data"));
		data.put("result_id", request.resultId());
		data.put("trace_refs", List.of());
		List<StaffingPlan> staffing = OperationResultContract.staffing(data.get("staffing"))
				.stream().map(StaffingPlan::fromConfirmedPlan).toList();
		return new SimulationResult(ApiResponse.ok(data), staffing, key);
	}

	@ParameterizedTest
	@CsvSource({"false,result", "true,review", "false,saved"})
	void 다른_실행이_완료되거나_실패해도_남은_실행이_있으면_삭제할_수_없다(boolean firstFails, String step) throws Exception {
		var firstEntered = new CountDownLatch(1);
		var secondEntered = new CountDownLatch(1);
		var releaseFirst = new CountDownLatch(1);
		var releaseSecond = new CountDownLatch(1);
		doAnswer(call -> {
			String key = call.getArgument(1);
			boolean first = key.startsWith("first:");
			(first ? firstEntered : secondEntered).countDown();
			if (!(first ? releaseFirst : releaseSecond).await(10, TimeUnit.SECONDS)) {
				throw new IllegalStateException("테스트 실행 대기 시간 초과");
			}
			if (first && firstFails) throw new IllegalStateException("첫 실행 실패");
			return simulationResponse(call.getArgument(0), key);
		}).when(simulation).compare(any(), anyString());
		if ("saved".equals(step)) jdbc.update("UPDATE work_session SET step='saved' WHERE session_id=520001");
		try (var pool = Executors.newFixedThreadPool(2)) {
			var first = pool.submit(() -> service.run(520001, 530001, "first"));
			var second = pool.submit(() -> service.run(520001, 530001, "second"));
			try {
				assertThat(firstEntered.await(10, TimeUnit.SECONDS)).isTrue();
				assertThat(secondEntered.await(10, TimeUnit.SECONDS)).isTrue();
				assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isEqualTo(2);
				releaseFirst.countDown();
				if (firstFails) {
					assertThatThrownBy(() -> first.get(10, TimeUnit.SECONDS)).hasCauseInstanceOf(IllegalStateException.class);
				} else {
					first.get(10, TimeUnit.SECONDS);
				}
				assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isEqualTo(1);
				assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=520001", String.class)).isEqualTo(step);
				assertThatThrownBy(() -> deletion.deleteSession(520001)).hasFieldOrPropertyWithValue("detailCode", "SESSION_RUNNING");
				releaseSecond.countDown();
				second.get(10, TimeUnit.SECONDS);
				assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isZero();
				deletion.deleteSession(520001);
			} finally {
				releaseFirst.countDown();
				releaseSecond.countDown();
			}
		}
	}

    @Test
    void 이전_프로세스의_카운터를_만료된_개별_기록으로_이관한다() throws Exception {
        String migration = Files.readString(Path.of("src/main/resources/db/migration/V6__calculation_run_leases.sql"));
        new TransactionTemplate(transactions).executeWithoutResult(status -> {
            jdbc.execute("CREATE SCHEMA lease_upgrade_test");
            jdbc.execute("SET LOCAL search_path TO lease_upgrade_test");
            jdbc.execute("CREATE TABLE work_session(session_id BIGINT PRIMARY KEY, active_operation_runs INTEGER NOT NULL)");
            jdbc.execute("CREATE TABLE work_result(result_id BIGINT PRIMARY KEY)");
            jdbc.execute("INSERT INTO work_session VALUES (1, 2), (2, 0)");
            jdbc.execute(migration);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM calculation_run WHERE session_id=1 AND lease_until<=clock_timestamp()", Integer.class)).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=1", Integer.class)).isEqualTo(2);
            assertThat(jdbc.queryForObject("SELECT count(*) FROM calculation_run WHERE session_id=2", Integer.class)).isZero();
            status.setRollbackOnly();
        });
    }

    @Test
    void 만료된_실행만_회수하고_현재_실행은_보존한다() {
        try (var live = runs.start(520001, "operation", () -> {})) {
            jdbc.update("INSERT INTO calculation_run VALUES (?, 520001, 'operation', now()-interval '1 minute')", java.util.UUID.randomUUID());
            jdbc.update("UPDATE work_session SET active_operation_runs=2, step='saved' WHERE session_id=520001");
            new TransactionTemplate(transactions).executeWithoutResult(status -> {
                sessions.lockSession(520001);
                runs.recover(520001);
            });
            live.requireActive();
            assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isEqualTo(1);
            assertThatThrownBy(() -> deletion.deleteSession(520001)).hasFieldOrPropertyWithValue("detailCode", "SESSION_RUNNING");
        }
        deletion.deleteSession(520001);
    }

    @Test
    void 중단된_실행의_만료된_기록과_running_단계를_복구한_뒤_삭제할_수_있다() {
        jdbc.update("INSERT INTO calculation_run VALUES (?, 520001, 'operation', now()-interval '1 minute')", java.util.UUID.randomUUID());
        jdbc.update("UPDATE work_session SET active_operation_runs=1, step='running' WHERE session_id=520001");
        deletion.deleteSession(520001);
        assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isZero();
    }

    @Test
    void 종료_정리가_실패해도_그_실행만_만료_후_회수한다() {
        var abandoned = runs.start(520001, "operation", () -> {});
        var abandonedId = jdbc.queryForObject("SELECT run_id FROM calculation_run WHERE session_id=520001", java.util.UUID.class);
        try (var live = runs.start(520001, "operation", () -> {})) {
            org.mockito.Mockito.doThrow(new RuntimeException("cleanup unavailable")).when(sessions).lockSession(520001);
            abandoned.close();
            org.mockito.Mockito.doCallRealMethod().when(sessions).lockSession(520001);
            // The closed request stopped renewing. Simulate expiry without sleeping for two minutes.
            jdbc.update("UPDATE calculation_run SET lease_until=now()-interval '1 minute' WHERE run_id=?", abandonedId);
            new TransactionTemplate(transactions).executeWithoutResult(status -> {
                sessions.lockSession(520001);
                runs.recover(520001);
            });
            live.requireActive();
            assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isEqualTo(1);
            assertThatThrownBy(() -> deletion.deleteSession(520001)).hasFieldOrPropertyWithValue("detailCode", "SESSION_RUNNING");
        }
        deletion.deleteSession(520001);
    }

    @Test
    void 만료된_실행은_결과를_저장할_수_없다() {
        try (var run = runs.start(520001, "operation", () -> {})) {
            jdbc.update("UPDATE calculation_run SET lease_until=now()-interval '1 minute'");
            assertThatThrownBy(run::requireActive).hasFieldOrPropertyWithValue("detailCode", "CALCULATION_EXPIRED");
        }
        assertThat(jdbc.queryForObject("SELECT active_operation_runs FROM work_session WHERE session_id=520001", Integer.class)).isZero();
    }

	@Test
	void 삭제_트랜잭션이_먼저_잠그면_대기한_계산은_running_기록_전에_거부한다() throws Exception {
		var attemptingLock = new CountDownLatch(1);
		doAnswer(call -> {
			attemptingLock.countDown();
			return call.callRealMethod();
		}).when(sessions).lockSession(520001);
		try (var pool = Executors.newSingleThreadExecutor()) {
			var pending = new AtomicReference<Future<?>>();
			new TransactionTemplate(transactions).executeWithoutResult(status -> {
				jdbc.query("SELECT session_id FROM work_session WHERE session_id=520001 FOR UPDATE", rs -> {});
				jdbc.update("UPDATE work_session SET deleted_at=now() WHERE session_id=520001");
				pending.set(pool.submit(() -> service.run(520001, 530001, "delete-wins")));
				try {
					assertThat(attemptingLock.await(10, TimeUnit.SECONDS)).isTrue();
				} catch (InterruptedException e) {
					Thread.currentThread().interrupt();
					throw new IllegalStateException(e);
				}
			});
			assertThatThrownBy(() -> pending.get().get(10, TimeUnit.SECONDS))
					.hasCauseInstanceOf(ApiException.class)
					.satisfies(error -> assertThat(((ApiException) error.getCause()).getDetailCode())
							.isEqualTo("SESSION_NOT_FOUND"));
		}
		verifyNoInteractions(simulation, client);
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=520001", String.class)).isEqualTo("input");
		assertThat(jdbc.queryForObject("SELECT count(*) FROM work_result", Integer.class)).isZero();
	}

	@ParameterizedTest
	@ValueSource(strings = {"{}", "{\"operation_form\":{\"daily_orders\":150}}"})
	void 필수_입력_누락_결과_저장_직전에_업무가_삭제되면_저장하지_않는다(String inputJson) {
		jdbc.update("UPDATE work_version SET input_json=?::jsonb WHERE input_version_id=530001", inputJson);
		doAnswer(call -> {
			var deletionTransaction = new TransactionTemplate(transactions);
			deletionTransaction.setPropagationBehavior(org.springframework.transaction.TransactionDefinition.PROPAGATION_REQUIRES_NEW);
			deletionTransaction.executeWithoutResult(status -> deletion.deleteSession(520001));
			return call.callRealMethod();
		}).when(repository).lockSession(520001);
		assertThatThrownBy(() -> service.run(520001, 530001, "missing-delete-before-save"))
				.hasFieldOrPropertyWithValue("detailCode", "SESSION_NOT_FOUND");
		assertThat(jdbc.queryForObject("SELECT count(*) FROM work_result", Integer.class)).isZero();
		assertThat(jdbc.queryForObject("SELECT deleted_at IS NOT NULL FROM work_session WHERE session_id=520001", Boolean.class)).isTrue();
		verifyNoInteractions(simulation, client);
	}

	@ParameterizedTest
	@ValueSource(strings = {"{}", "{\"operation_form\":{\"daily_orders\":150}}"})
	void 삭제되지_않은_업무의_필수_입력_누락은_실제_DB에_저장된다(String inputJson) {
		jdbc.update("UPDATE work_version SET input_json=?::jsonb WHERE input_version_id=530001", inputJson);
		assertThat(service.run(520001, 530001, "missing-valid").status())
				.isEqualTo(com.solution.common.response.ResponseStatus.NEEDS_INPUT);
		assertThat(jdbc.queryForObject("SELECT response_status FROM work_result", String.class)).isEqualTo("needs_input");
		assertThat(jdbc.queryForObject("SELECT step FROM work_session WHERE session_id=520001", String.class)).isEqualTo("review");
		verifyNoInteractions(simulation, client);
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
