package com.solution.operation.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.common.response.ApiResponse;
import com.solution.operation.service.OperationResultRepository.SessionVersion;
import com.solution.operation.service.OperationResultRepository.StoredResult;
import com.solution.operation.service.OperationResultRepository.Trace;
import com.solution.operation.service.labor.LaborService;
import com.solution.operation.service.simulation.SimulationService;
import com.solution.operation.dto.simulation.SimulationRequest;
import com.solution.operation.dto.simulation.SimulationResult;
import com.solution.operation.dto.StaffingPlan;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

@SuppressWarnings("unchecked")
class OperationResultServiceTest {

	private static final long SESSION = 520001, VERSION = 530001, RESULT = 7001;
	private final ObjectMapper mapper = JsonMapper.builder().build();
	private final TypeReference<Map<String, Object>> type = new TypeReference<>() { };
	private OperationResultRepository repository;
	private AiServerClient client;
	private SimulationService simulationService;
	private List<StaffingPlan> staffing;
	private OperationResultService service;
	private Map<Long, StoredResult> saved;
	private AtomicInteger currentVersion;
	private RequestKeyLock requestKeyLock;

	@BeforeEach
	void setUp() throws IOException {
		repository = mock(OperationResultRepository.class);
		client = mock(AiServerClient.class);
		simulationService = mock(SimulationService.class);
		staffing = ((List<Map<String, Object>>) map(fixture("input.json").get("labor")).get("plans"))
				.stream().map(StaffingPlan::fromConfirmedPlan).toList();
		IdGenerator ids = mock(IdGenerator.class);
		when(ids.next()).thenReturn(RESULT);
		requestKeyLock = mock(RequestKeyLock.class);
		service = new OperationResultService(repository, simulationService, new LaborService(client), new CurrentOwner("demo-owner"), ids, mapper,
				new TransactionTemplate(mock(PlatformTransactionManager.class)), requestKeyLock);
		saved = new HashMap<>();
		currentVersion = new AtomicInteger(1);
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("demo-owner", "operation", 1, true)));
		when(repository.findByRequestKey(anyLong(), anyString())).thenReturn(Optional.empty());
		doAnswer(call -> { StoredResult row = call.getArgument(0); saved.put(row.resultId(), row); return null; })
				.when(repository).insertResult(any(), any(), anyString());
		when(repository.findResult(anyLong(), anyBoolean())).thenAnswer(call -> {
			StoredResult row = saved.get((Long) call.getArgument(0));
			if (row == null) return Optional.empty();
			return Optional.of(new StoredResult(row.resultId(), row.inputVersionId(), row.sessionId(), row.versionNo(),
					row.featureType(), row.responseStatus(), row.detailStatus(), row.summaryJson(),
					(Boolean) call.getArgument(1) ? row.detailJson() : null, row.createdAt(), currentVersion.get(), row.ownerKey(), row.confirmedChoiceKey()));
		});
		tool("/tools/simulation/compare", ApiResponse.ok(data("compare_response.json")));
		Map<String, Object> preview = fixture("preview.json");
		Map<String, Object> detail = map(map(preview.get("result")).get("detail"));
		tool("/tools/labor/schedule", ApiResponse.ok(map(detail.get("schedule"))));
		tool("/tools/labor/cost", ApiResponse.ok(data("expected_cost.json")));
	}

	private SessionVersion source(String actor, String feature, int current, boolean confirmed) throws IOException {
		return new SessionVersion(SESSION, 510001, feature, current, actor, VERSION, 1,
				Files.readString(Path.of("../data/demo/operation/input.json")),
				confirmed ? OffsetDateTime.parse("2026-11-13T09:00:00+09:00") : null);
	}

	private Map<String, Object> fixture(String name) throws IOException {
		return mapper.readValue(Files.readString(Path.of("../data/demo/operation", name)), type);
	}

	private Map<String, Object> data(String name) throws IOException { return map(fixture(name).get("data")); }
	private static Map<String, Object> map(Object value) { return (Map<String, Object>) value; }

	private void tool(String path, ApiResponse<Map<String, Object>> result) {
		if (path.equals("/tools/simulation/compare")) {
			when(simulationService.compare(any(), anyString())).thenAnswer(call -> new SimulationResult(result, staffing, call.getArgument(1)));
			return;
		}
		when(client.post(eq(path), any(), anyString(), any(ParameterizedTypeReference.class))).thenReturn(result);
	}

	@Test
	void preservesStatisticsAndCallsThreeToolsInOrder() {
		var response = service.run(SESSION, VERSION, "run-1");
		assertThat(response.status().getValue()).isEqualTo("ok");
		Map<String, Object> summary = map(response.data().get("summary"));
		assertThat(map(summary.get("recommendation"))).containsEntry("choice_key", "ALT_C");
		var order = inOrder(simulationService, client);
		order.verify(simulationService).compare(any(SimulationRequest.class), eq("run-1:simulation"));
		order.verify(client).post(eq("/tools/labor/schedule"), any(), eq("run-1:schedule"), any(ParameterizedTypeReference.class));
		order.verify(client).post(eq("/tools/labor/cost"), any(), eq("run-1:cost"), any(ParameterizedTypeReference.class));
		assertThat(saved.get(RESULT).summaryJson()).doesNotContain("\"events\"");
		assertThat(saved.get(RESULT).detailJson()).contains("trace_refs", "metric_definitions", "schedule");
		assertThat(response.data().get("detail")).isNull();
		List<Map<String, Object>> plans = (List<Map<String, Object>>) summary.get("choices");
		assertThat(plans.get(2)).containsEntry("additional_cash_cost_krw", 20640);
		assertThat(map(plans.get(2).get("metrics"))).containsEntry("total_time_mean_seconds", 180);
	}

	@Test
	void requiresInputConfirmationBeforeRunning() throws IOException {
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("demo-owner", "operation", 1, false)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOfSatisfying(ApiException.class,
				e -> assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST));
		verifyNoInteractions(client);
	}

	@Test
	void hidesOtherOwnerOrFeature() throws IOException {
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("another-owner", "operation", 1, true)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOfSatisfying(ApiException.class,
				e -> assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("demo-owner", "purchase", 1, true)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(ApiException.class);
		verifyNoInteractions(client);
	}

	@Test
	void rejectsStaleInput() throws IOException {
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("demo-owner", "operation", 2, true)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(ApiException.class);
		verifyNoInteractions(client);
	}

	@Test
	void returnsSavedRetryWithoutRecalculation() {
		service.run(SESSION, VERSION, "run-1");
		when(repository.findByRequestKey(SESSION, "run-1")).thenReturn(Optional.of(saved.get(RESULT)));
		clearInvocations(client);
		assertThat(service.run(SESSION, VERSION, "run-1").data()).containsEntry("result_id", RESULT);
		verifyNoInteractions(client);
	}

	@Test
	void rejectsKeyReusedWithDifferentInput() {
		service.run(SESSION, VERSION, "run-1");
		StoredResult old = saved.get(RESULT);
		when(repository.findByRequestKey(SESSION, "run-1")).thenReturn(Optional.of(new StoredResult(old.resultId(), VERSION-1,
				old.sessionId(), old.versionNo(), old.featureType(), old.responseStatus(), old.detailStatus(), old.summaryJson(),
				old.detailJson(), old.createdAt(), old.currentVersion(), old.ownerKey(), null)));
		clearInvocations(client);
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(ApiException.class);
		verifyNoInteractions(client);
	}

	// ===== v0.4 계약: 사유 코드 · Idempotency-Key · complete · choices · 경고 =====

	@Test
	void 오류마다_사유_코드를_붙인다() throws IOException {
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("demo-owner", "operation", 1, false)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1"))
				.hasFieldOrPropertyWithValue("detailCode", "INPUT_NOT_CONFIRMED");
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("demo-owner", "operation", 2, true)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1"))
				.hasFieldOrPropertyWithValue("detailCode", "STALE_VERSION");
		when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(source("another-owner", "operation", 1, true)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1"))
				.hasFieldOrPropertyWithValue("detailCode", "SESSION_NOT_FOUND");
		assertThatThrownBy(() -> service.result(9999, "summary"))
				.hasFieldOrPropertyWithValue("detailCode", "RESULT_NOT_FOUND");
		assertThatThrownBy(() -> service.result(RESULT, "full"))
				.hasFieldOrPropertyWithValue("detailCode", "INVALID_REQUEST");
		verifyNoInteractions(client);
	}

	@Test
	void 같은_키에_다른_입력이면_IDEMPOTENCY_KEY_REUSED() {
		service.run(SESSION, VERSION, "run-1");
		StoredResult old = saved.get(RESULT);
		when(repository.findByRequestKey(SESSION, "run-1")).thenReturn(Optional.of(new StoredResult(old.resultId(), VERSION - 1,
				old.sessionId(), old.versionNo(), old.featureType(), old.responseStatus(), old.detailStatus(), old.summaryJson(),
				old.detailJson(), old.createdAt(), old.currentVersion(), old.ownerKey(), null)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1"))
				.isInstanceOfSatisfying(ApiException.class, e -> {
					assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
					assertThat(e.getDetailCode()).isEqualTo("IDEMPOTENCY_KEY_REUSED");
				});
	}

	@Test
	void Idempotency_Key가_없거나_비었거나_길면_INVALID_REQUEST() {
		for (String key : new String[] { null, "", "   ", "가".repeat(3), "k".repeat(101) }) {
			assertThatThrownBy(() -> service.run(SESSION, VERSION, key))
					.isInstanceOfSatisfying(ApiException.class, e -> {
						assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
						assertThat(e.getDetailCode()).isEqualTo("INVALID_REQUEST");
					});
		}
		// UUID처럼 출력 가능한 ASCII 100자까지는 받는다.
		assertThat(service.run(SESSION, VERSION, "k".repeat(100)).status().getValue()).isEqualTo("ok");
	}

	@Test
	void 성공_결과는_choices와_complete_true로_저장한다() throws IOException {
		var response = service.run(SESSION, VERSION, "run-1");
		Map<String, Object> summary = map(response.data().get("summary"));
		assertThat(summary).containsEntry("complete", true).doesNotContainKeys("plans", "choice_keys");
		assertThat((List<Map<String, Object>>) summary.get("choices")).extracting(row -> row.get("choice_key"))
				.containsExactly("CURRENT", "ALT_A", "ALT_C");
		Map<String, Object> stored = mapper.readValue(saved.get(RESULT).summaryJson(), type);
		assertThat(stored).containsEntry("complete", true).containsKey("choices");
		assertThat(map(mapper.readValue(saved.get(RESULT).detailJson(), type).get("labor"))).containsKey("plans");
	}

	@Test
	void complete가_false면_저장하지_않고_RESULT_NOT_READY() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		simulation.put("complete", false);
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1"))
				.isInstanceOfSatisfying(ApiException.class, e -> {
					assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST);
					assertThat(e.getDetailCode()).isEqualTo("RESULT_NOT_READY");
				});
		verify(repository, never()).insertResult(any(), any(), anyString());
		verify(client, never()).post(eq("/tools/labor/schedule"), any(), anyString(), any(ParameterizedTypeReference.class));
	}

	@Test
	void complete가_boolean이_아니거나_없으면_계약_오류() throws IOException {
		for (Object value : new Object[] { "true", 1, null }) {
			Map<String, Object> simulation = data("compare_response.json");
			if (value == null) {
				simulation.remove("complete");
			}
			else {
				simulation.put("complete", value);
			}
			tool("/tools/simulation/compare", ApiResponse.ok(simulation));
			assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-" + value)).isInstanceOf(AiServerException.class);
		}
		verify(repository, never()).insertResult(any(), any(), anyString());
	}

	@Test
	void 질문_결과는_complete_false와_빈_choices로_저장한다() throws IOException {
		tool("/tools/simulation/compare", ApiResponse.needsInput(new java.util.LinkedHashMap<>(Map.of(
				"detail_status", "NEEDS_INPUT",
				"missing_fields", List.of(Map.of("path", "arrivals", "label", "손님 도착", "unit", "명")))),
				"손님 도착 조건을 알려 주세요."));
		var response = service.run(SESSION, VERSION, "run-1");
		assertThat(response.status().getValue()).isEqualTo("needs_input");
		assertThat(response.data()).containsEntry("complete", false).containsEntry("choices", List.of())
				.containsEntry("recommendation", null);
		assertThat(response.message()).isEqualTo("손님 도착 조건을 알려 주세요.");
	}

	@Test
	void 등록되지_않은_경고_ID도_requires_ack로_받고_모의조건은_필수로_둔다() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		simulation.put("warnings", List.of(Map.of("warning_id", "WARMUP_EXCLUDED", "message", "워밍업 구간을 뺐어요.",
				"requires_ack", false)));
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		var warnings = (List<Map<String, Object>>) map(service.run(SESSION, VERSION, "run-1").data().get("summary")).get("warnings");
		assertThat(warnings).extracting(row -> row.get("warning_id")).containsExactly("WARMUP_EXCLUDED", "SIMULATED_CONDITIONS");
		assertThat(warnings.get(1)).containsEntry("requires_ack", true);
	}

	@Test
	void 늦은_요청이_실패해도_앞_요청이_저장한_성공_결과의_단계를_지킨다() throws IOException {
		service.run(SESSION, VERSION, "first");
		StoredResult previous = saved.get(RESULT);
		clearInvocations(repository);
		// 처음 조회 때는 없었지만, 실패 처리 시점에는 같은 키로 앞 요청의 성공 결과가 저장돼 있다.
		when(repository.findByRequestKey(SESSION, "late"))
				.thenReturn(Optional.empty(), Optional.of(previous));
		Map<String, Object> simulation = data("compare_response.json");
		simulation.put("complete", false);
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "late")).isInstanceOf(ApiException.class);
		var order = inOrder(requestKeyLock, repository);
		order.verify(repository).markStep(SESSION, 1, "running");
		order.verify(requestKeyLock).lock("operation", VERSION, "late");
		order.verify(repository).markStep(SESSION, 1, "result");
		verify(repository, never()).markStep(SESSION, 1, "review");
	}

	@Test
	void warnings가_배열이_아니면_계약_오류() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		simulation.put("warnings", Map.of("warning_id", "SIMULATED_CONDITIONS", "message", "모의 조건", "requires_ack", true));
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(AiServerException.class);
		verify(repository, never()).insertResult(any(), any(), anyString());
	}

	@Test
	void 같은_키_결과가_먼저_저장됐으면_단계를_그_결과에_맞게_되돌린다() {
		service.run(SESSION, VERSION, "first");
		StoredResult previous = saved.get(RESULT);
		clearInvocations(repository);
		// 처음 조회 때는 없다가, 저장 직전 잠금 안에서 다시 보니 다른 요청이 이미 저장한 경우
		when(repository.findByRequestKey(SESSION, "race"))
				.thenReturn(Optional.empty(), Optional.of(previous), Optional.of(previous));
		service.run(SESSION, VERSION, "race");
		var order = inOrder(repository);
		order.verify(repository).markStep(SESSION, 1, "running");
		order.verify(repository).markStep(SESSION, 1, "result");
		verify(repository, never()).insertResult(any(), any(), eq("race"));
	}

	@Test
	void 모의조건_경고를_참고로_낮추면_계약_오류() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		simulation.put("warnings", List.of(Map.of("warning_id", "SIMULATED_CONDITIONS", "message", "모의 조건",
				"requires_ack", false)));
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(AiServerException.class);
	}

	@Test
	void doesNotSaveIncompleteReplications() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		simulation.put("completed_repetitions", 29);
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(AiServerException.class);
		verify(repository, never()).insertResult(any(), any(), anyString());
		verify(repository).markStep(SESSION, 1, "review");
	}

	@Test
	void doesNotRenamePostOrderP90ToTotalP90() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		Map<String, Object> metrics = map(((List<?>) simulation.get("results")).getFirst());
		metrics = map(metrics.get("metrics"));
		metrics.put("p90_post_order_receipt_sec", metrics.remove("total_time_p90_seconds"));
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(AiServerException.class);
		assertThat(saved).isEmpty();
	}

	@Test
	void mapsMissingLaborPathAndSavesQuestion() {
		Map<String, Object> field = new HashMap<>(); field.put("path", "weekly_context"); field.put("label", "주간 근무 조건"); field.put("unit", null);
		tool("/tools/labor/cost", ApiResponse.needsInput(Map.of("missing_fields", List.of(field), "detail_status", "MISSING_COST_CONTEXT"), "주간 조건을 확인해 주세요."));
		var response = service.run(SESSION, VERSION, "run-1");
		assertThat(response.status().getValue()).isEqualTo("needs_input");
		assertThat(response.message()).isEqualTo("주간 조건을 확인해 주세요.");
		assertThat(saved.get(RESULT).detailJson()).isNull();
		assertThat(saved.get(RESULT).summaryJson()).contains("labor.weekly_context");
		assertThat(service.result(RESULT, "summary").data()).containsEntry("response_status", "needs_input");
	}

	@Test
	void stopsBeforeCostWhenScheduleInfeasible() {
		tool("/tools/labor/schedule", ApiResponse.infeasible(Map.of("detail_status", "SCHEDULE_INFEASIBLE", "violations", List.of()), "배치가 불가능합니다."));
		assertThat(service.run(SESSION, VERSION, "run-1").status().getValue()).isEqualTo("infeasible");
		verify(client, never()).post(eq("/tools/labor/cost"), any(), anyString(), any(ParameterizedTypeReference.class));
	}

	@Test
	void keepsOriginalVersionForLateResponse() throws IOException {
		ApiResponse<Map<String, Object>> response = ApiResponse.ok(data("expected_cost.json"));
		when(client.post(eq("/tools/labor/cost"), any(), anyString(), any(ParameterizedTypeReference.class))).thenAnswer(call -> {
			currentVersion.set(2); return response;
		});
		assertThat(service.run(SESSION, VERSION, "run-1").data()).containsEntry("is_latest_version", false);
		assertThat(saved.get(RESULT).inputVersionId()).isEqualTo(VERSION);
	}

	@Test
	void readsSummaryWithoutDetailOrTools() {
		service.run(SESSION, VERSION, "run-1");
		clearInvocations(client, repository);
		assertThat(service.result(RESULT, "summary").data().get("detail")).isNull();
		verify(repository).findResult(RESULT, false);
		assertThat(service.result(RESULT, "detail").data().get("detail")).isNotNull();
		verifyNoInteractions(client);
	}

	@Test
	void hidesOtherOwnersResult() {
		service.run(SESSION, VERSION, "run-1");
		StoredResult row = saved.get(RESULT);
		saved.put(RESULT, new StoredResult(row.resultId(), row.inputVersionId(), row.sessionId(), row.versionNo(), row.featureType(),
				row.responseStatus(), row.detailStatus(), row.summaryJson(), row.detailJson(), row.createdAt(), row.currentVersion(), "another", null));
		assertThatThrownBy(() -> service.result(RESULT, "summary")).isInstanceOfSatisfying(ApiException.class,
				e -> assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
	}

	@Test
	void allowlistsTracePayload() throws IOException {
		service.run(SESSION, VERSION, "run-1");
		Map<String, Object> payload = map(((List<?>) fixture("preview.json").get("traces")).getFirst());
		payload.put("raw_prompt", "never expose");
		when(repository.findTrace(RESULT, 9001)).thenReturn(Optional.of(new Trace(9001, RESULT, VERSION, SESSION, mapper.writeValueAsString(payload))));
		clearInvocations(client);
		Map<String, Object> data = service.trace(RESULT, 9001).data();
		assertThat(data).doesNotContainKey("raw_prompt");
		assertThat(map(data.get("initial_state"))).containsKey("preparation_queue");
		assertThat(data.get("is_complete")).isEqualTo(false);
		verifyNoInteractions(client);
	}

	@Test
	void hidesTraceOfAnotherResult() {
		service.run(SESSION, VERSION, "run-1");
		when(repository.findTrace(RESULT, 9001)).thenReturn(Optional.of(new Trace(9001, 9999, VERSION, SESSION, "{}")));
		assertThatThrownBy(() -> service.trace(RESULT, 9001)).isInstanceOfSatisfying(ApiException.class,
				e -> assertThat(e.getStatus()).isEqualTo(HttpStatus.NOT_FOUND));
	}

	@Test
	void requiresFullStaffingForLabor() throws IOException {
		var response = ApiResponse.ok(data("compare_response.json"));
		when(simulationService.compare(any(), anyString())).thenAnswer(call -> new SimulationResult(response, null, call.getArgument(1)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(AiServerException.class);
		verifyNoInteractions(client);
		assertThat(saved).isEmpty();
	}

	@Test
	void rejectsStaffingDifferentFromConfirmedInput() throws IOException {
		var response = ApiResponse.ok(data("compare_response.json"));
		List<StaffingPlan> partial = List.of(new StaffingPlan("ALT_C", List.of(
				new StaffingPlan.Shift("STAFF_2", "11:00", "14:00", "PREPARATION"))));
		when(simulationService.compare(any(), anyString())).thenAnswer(call -> new SimulationResult(response, partial, call.getArgument(1)));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1")).isInstanceOf(AiServerException.class);
		verifyNoInteractions(client);
	}

	@Test
	void doesNotInventClosingStatistics() {
		service.run(SESSION, VERSION, "run-1");
		assertThat(saved.get(RESULT).summaryJson()).doesNotContain("closing", "failed_repetitions", "success_ratio");
	}

	@Test
	void locksAndChecksAgainBeforeSavingConcurrentRetry() {
		service.run(SESSION, VERSION, "first");
		StoredResult previous = saved.get(RESULT);
		clearInvocations(repository, requestKeyLock);
		when(repository.findByRequestKey(SESSION, "race"))
				.thenReturn(Optional.empty(), Optional.of(previous), Optional.of(previous));
		var response = service.run(SESSION, VERSION, "race");
		assertThat(response.data()).containsEntry("result_id", RESULT);
		var order = inOrder(requestKeyLock, repository);
		order.verify(repository).findByRequestKey(SESSION, "race");
		order.verify(requestKeyLock).lock("operation", VERSION, "race");
		order.verify(repository).lockSession(SESSION);
		order.verify(repository, times(2)).findByRequestKey(SESSION, "race");
		verify(repository, never()).insertResult(any(), any(), eq("race"));
	}

	@Test
	void rejectsDuplicateReplicationInsteadOfClaimingThirtyDistinctRuns() throws IOException {
		Map<String, Object> simulation = data("compare_response.json");
		var repetitions = (List<Map<String, Object>>)simulation.get("replication_metrics");
		repetitions.get(29).put("replication_no", 1);
		tool("/tools/simulation/compare", ApiResponse.ok(simulation));
		assertThatThrownBy(() -> service.run(SESSION, VERSION, "run-1"))
				.isInstanceOf(AiServerException.class);
		assertThat(saved).isEmpty();
	}

	@Test
	void summarizesStaffingBeforeEffectsWithoutExtendingTwoHourShift() {
		var response = service.run(SESSION, VERSION, "run-1");
		var plans = (List<Map<String, Object>>)map(response.data().get("summary")).get("choices");
		Map<String, Object> staffingSummary = map(plans.get(2).get("staffing_summary"));
		assertThat(staffingSummary).containsEntry("max_concurrent_workers", 3);
		var assignments = (List<Map<String, Object>>)staffingSummary.get("assignments");
		assertThat(assignments).anySatisfy(row -> assertThat(row)
				.containsEntry("worker_key", "STAFF_2").containsEntry("start_time", "11:30")
				.containsEntry("end_time", "13:30"));
	}

	@Test
	void legacyReplayWithoutInitialSnapshotRemainsExplicitlyUnknown() throws IOException {
		service.run(SESSION, VERSION, "run-1");
		Map<String, Object> payload = map(((List<?>)fixture("preview.json").get("traces")).getFirst());
		payload.remove("initial_state");
		payload.put("trace_schema_version", "operation.trace.v1");
		when(repository.findTrace(RESULT, 9001)).thenReturn(Optional.of(
				new Trace(9001, RESULT, VERSION, SESSION, mapper.writeValueAsString(payload))));
		assertThat(service.trace(RESULT, 9001).data()).containsEntry("initial_state", null);
	}
    @Test
    void preservesClosingWithoutInventingSuccess() throws IOException {
        Map<String, Object> simulation = data("compare_response.json");
        Map<String, Object> closing = Map.of("failed_repetitions", 3, "success_ratio", 0.9,
                "policy_version", "test-only-closing");
        ((List<Map<String, Object>>)simulation.get("results")).get(2).put("closing", closing);
        tool("/tools/simulation/compare", ApiResponse.ok(simulation));
        var response = service.run(SESSION, VERSION, "closing-1");
        var plans = (List<Map<String, Object>>)map(response.data().get("summary")).get("choices");
        assertThat(plans.getFirst()).containsKey("closing");
        assertThat(plans.getFirst().get("closing")).isNull();
        assertThat(plans.get(2).get("closing")).isEqualTo(closing);
    }

    @Test
    void rejectsScheduleChangingConfirmedStaffingBeforeCost() throws IOException {
        var detail = map(map(fixture("preview.json").get("result")).get("detail"));
        var schedule = map(detail.get("schedule"));
        var plans = (List<Map<String, Object>>)schedule.get("plans");
        var shifts = (List<Map<String, Object>>)plans.get(2).get("schedule");
        shifts.getLast().put("end_time", "13:00");
        tool("/tools/labor/schedule", ApiResponse.ok(schedule));
        assertThatThrownBy(() -> service.run(SESSION, VERSION, "bad-schedule")).isInstanceOf(AiServerException.class);
        verify(client, never()).post(eq("/tools/labor/cost"), any(), anyString(), any(ParameterizedTypeReference.class));
        assertThat(saved).isEmpty();
    }

    @Test
    void combinesThreeHourProposalWithExplicitWorkerContext() throws IOException {
        var input = fixture("staffing_proposal/input.json");
        when(repository.findSessionVersion(SESSION, VERSION)).thenReturn(Optional.of(new SessionVersion(
                SESSION, 510001, "operation", 1, "demo-owner", VERSION, 1, mapper.writeValueAsString(input), OffsetDateTime.now())));
        staffing = ((List<Map<String, Object>>)map(input.get("labor")).get("plans")).stream()
                .map(StaffingPlan::fromConfirmedPlan).toList();
        tool("/tools/simulation/compare", ApiResponse.ok(data("staffing_proposal/compare_response.json")));
        tool("/tools/labor/schedule", ApiResponse.ok(data("staffing_proposal/schedule_response.json")));
        tool("/tools/labor/cost", ApiResponse.ok(data("staffing_proposal/expected_cost.json")));
        var response = service.run(SESSION, VERSION, "staffing-review");
        var plans = (List<Map<String, Object>>)map(response.data().get("summary")).get("choices");
        assertThat(plans.get(2)).containsEntry("additional_cash_cost_krw", 30960);
        assertThat(map(plans.get(2).get("staffing_summary"))).containsEntry("total_staff_hours", 24.0);
        assertThat(map(plans.get(2).get("staffing"))).containsKey("employees");
        assertThat(saved.get(RESULT).detailJson()).contains("simulation_choices", "primary_role", "can_support");
    }

}
