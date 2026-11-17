package com.solution.operation.service;

import com.solution.operation.service.labor.LaborService;

import com.solution.operation.service.simulation.SimulationService;

import static com.solution.operation.service.OperationResultContract.map;
import static com.solution.operation.service.OperationResultContract.maps;
import static com.solution.operation.service.OperationResultContract.require;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.operation.service.OperationResultRepository.SessionVersion;
import com.solution.operation.service.OperationResultRepository.StoredResult;
import com.solution.operation.service.OperationResultRepository.Trace;
import com.solution.operation.dto.simulation.SimulationRequest;
import com.solution.operation.dto.simulation.SimulationResult;
import com.solution.operation.dto.StaffingPlan;
import com.solution.operation.dto.labor.LaborRequest;
import com.solution.operation.dto.OperationResultResponse;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/** 확인된 입력 → simulation → 배치표 → 인건비 → 결과 저장. 최종 확정은 공통 decision 담당이다. */
@Service
public class OperationResultService {

	private static final TypeReference<LinkedHashMap<String, Object>> JSON_MAP = new TypeReference<>() { };
	// 오류 사유 코드 (data.detail_code). 구매·확정 API와 같은 이름을 쓴다 (상태코드·경고 점검 공유사항 11.17, 현식 API v0.4).
	static final String CODE_INVALID_REQUEST = "INVALID_REQUEST";
	static final String CODE_SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
	static final String CODE_RESULT_NOT_FOUND = "RESULT_NOT_FOUND";
	static final String CODE_STALE_VERSION = "STALE_VERSION";
	static final String CODE_INPUT_NOT_CONFIRMED = "INPUT_NOT_CONFIRMED";
	static final String CODE_IDEMPOTENCY_KEY_REUSED = "IDEMPOTENCY_KEY_REUSED";
	static final String CODE_RESULT_NOT_READY = "RESULT_NOT_READY";
	static final String SIMULATED_CONDITIONS = "SIMULATED_CONDITIONS";
	private static final String KEY_REUSED = "같은 요청키로 다른 내용을 보낼 수 없습니다.";
	private static final Set<String> EVENT_TYPES = Set.of("ARRIVED", "ORDER_STARTED", "ORDER_COMPLETED",
			"PREPARATION_STARTED", "PREPARATION_COMPLETED", "HANDOFF_STARTED", "HANDED_OVER", "STAFF_ON", "STAFF_OFF");
	private final OperationResultRepository repository;
	private final SimulationService simulationService;
	private final LaborService laborService;
	private final CurrentOwner owner;
	private final IdGenerator ids;
	private final ObjectMapper mapper;
	private final TransactionTemplate transaction;
	private final RequestKeyLock requestKeyLock;

	public OperationResultService(OperationResultRepository repository, SimulationService simulationService,
			LaborService laborService, CurrentOwner owner,
			IdGenerator ids, ObjectMapper mapper, TransactionTemplate transaction, RequestKeyLock requestKeyLock) {
		this.repository = repository;
		this.simulationService = simulationService;
		this.laborService = laborService;
		this.owner = owner;
		this.ids = ids;
		this.mapper = mapper;
		this.transaction = transaction;
		this.requestKeyLock = requestKeyLock;
	}

	public ApiResponse<Map<String, Object>> run(long sessionId, long versionId, String requestKey) {
		// Idempotency-Key는 필수, 1~100자, 공백만은 안 됨 (v0.4). 내부 단계 키(키:simulation 등)로도 쓰므로 출력 가능한 ASCII만 받는다.
		if (requestKey == null || requestKey.isBlank() || !requestKey.matches("[\\x20-\\x7E]{1,100}")) {
			throw ApiException.badRequest(CODE_INVALID_REQUEST, "Idempotency-Key는 1~100자의 요청 키여야 합니다.");
		}
		return runLocked(sessionId, versionId, requestKey);
	}

	private ApiResponse<Map<String, Object>> runLocked(long sessionId, long versionId, String key) {
		SessionVersion source = ownedSource(sessionId, versionId);
		if (!Objects.equals(source.versionNo(), source.currentVersion())) {
			throw ApiException.badRequest(CODE_STALE_VERSION, "조건이 바뀌었어요. 최신 입력을 확인한 뒤 계산해 주세요.");
		}
		if (source.inputConfirmedAt() == null) {
			throw ApiException.badRequest(CODE_INPUT_NOT_CONFIRMED, "입력을 먼저 확인해 주세요.");
		}
		var existing = repository.findByRequestKey(sessionId, key);
		if (existing.isPresent()) {
			if (existing.get().inputVersionId() != versionId) {
				throw ApiException.badRequest(CODE_IDEMPOTENCY_KEY_REUSED, KEY_REUSED);
			}
			return runResponse(existing.get());
		}
		Map<String, Object> input = read(source.inputJson());
		long resultId = ids.next();
		List<Map<String, Object>> missing = new ArrayList<>();
		for (String field : List.of("business_date", "wage_year", "assumptions_version", "simulation", "labor")) {
			if (input.get(field) == null) {
				Map<String, Object> row = new LinkedHashMap<>();
				row.put("path", field);
				row.put("label", field.equals("labor") ? "인원·근무 조건" : field.equals("simulation") ? "운영 실험 조건" : field);
				row.put("unit", null);
				missing.add(row);
			}
		}
		if (!missing.isEmpty()) {
			return save(source, resultId, key, ApiResponse.needsInput(
					Map.of("detail_status", "MISSING_OPERATION_INPUT", "missing_fields", missing), "계산에 필요한 운영 입력을 확인해 주세요."));
		}
		repository.markStep(sessionId, source.versionNo(), "running");
		try {
			Map<String, Object> laborInput = map(input.get("labor"));
			List<Map<String, Object>> staffing = OperationResultContract.staffing(laborInput.get("plans"));
			List<StaffingPlan> expected = staffing.stream().map(StaffingPlan::fromConfirmedPlan).toList();
			SimulationRequest request = new SimulationRequest(sessionId, versionId, resultId,
					map(input.get("simulation")), expected);
			SimulationResult returned = simulationService.compare(request, key + ":simulation");
			require(returned != null && (key + ":simulation").equals(returned.requestKey()));
			ApiResponse<Map<String, Object>> simulation = returned.response();
			require(simulation != null && simulation.status() != null && simulation.data() != null
					&& simulation.status() != ResponseStatus.ERROR);
			if (simulation.status() != ResponseStatus.OK) {
				return save(source, resultId, key, remapMissing(simulation, "simulation"));
			}
			// complete는 엄격한 boolean이다 (v0.4). 문자열 "true"·숫자 1·누락은 계약 오류(502),
			// false(30회 완주·집계 미완료)는 확정 가능한 성공으로 저장하지 않고 400 RESULT_NOT_READY.
			require(simulation.data().get("complete") instanceof Boolean);
			if (!Boolean.TRUE.equals(simulation.data().get("complete"))) {
				throw ApiException.badRequest(CODE_RESULT_NOT_READY, "30회 계산과 집계가 끝난 결과가 필요합니다.");
			}
			OperationResultContract.validateSimulation(simulation.data());
			// 직원별 하루 전체 계획이 확인되지 않으면 피크 인원 수로 인건비를 추측하지 않는다.
			require(returned.staffing() != null);
			require(staffing.equals(OperationResultContract.staffing(
					returned.staffing().stream().map(StaffingPlan::asMap).toList())));
			ApiResponse<Map<String, Object>> labor = laborService.calculate(new LaborRequest(input, sessionId, versionId), key);
			if (labor.status() != ResponseStatus.OK) {
				return save(source, resultId, key, remapMissing(labor, "labor"));
			}
			return save(source, resultId, key, combine(simulation.data(), map(labor.data().get("schedule")),
					map(labor.data().get("cost")), resultId));
		}
		catch (RuntimeException e) {
			repository.markStep(sessionId, source.versionNo(), "review");
			throw e;
		}
	}

	private SessionVersion ownedSource(long sessionId, long versionId) {
		return repository.findSessionVersion(sessionId, versionId)
				.filter(row -> "operation".equals(row.featureType()) && owner.key().equals(row.ownerKey()))
				.filter(row -> row.inputVersionId() != null)
				.orElseThrow(() -> ApiException.notFound(CODE_SESSION_NOT_FOUND, "운영 업무 또는 입력을 찾을 수 없습니다."));
	}

	private ApiResponse<Map<String, Object>> combine(Map<String, Object> simulation, Map<String, Object> schedule,
			Map<String, Object> cost, long resultId) {
		List<Map<String, Object>> summaries = new ArrayList<>();
		// 마감 판정은 simulation이 한 안이라도 준 경우에만 모든 안에 칸을 두고(없는 안은 null), 아무도 안 주면 칸을 만들지 않는다.
		boolean anyClosing = OperationResultContract.plans(simulation).stream().anyMatch(plan -> plan.get("closing") != null);
		for (Map<String, Object> plan : OperationResultContract.plans(simulation)) {
			Map<String, Object> money = OperationResultContract.plans(cost).stream()
					.filter(row -> row.get("choice_key").equals(plan.get("choice_key"))).findFirst().orElseThrow();
			for (String field : List.of("cash_cost_krw", "additional_cash_cost_krw", "owner_work_seconds",
					"employee_paid_seconds")) {
				OperationResultContract.number(money.get(field));
			}
			Map<String, Object> row = new LinkedHashMap<>();
			copy(plan, row, "choice_key", "metrics", "comparison", "staffing");
			if (anyClosing) {
				row.put("closing", plan.get("closing"));
			}
			copy(money, row, "cash_cost_krw", "additional_cash_cost_krw", "owner_work_seconds", "employee_paid_seconds",
					"base_wage_krw", "weekly_holiday_cost_krw", "employer_insurance_cost_krw", "cost_scope",
					"monthly_cash_cost_estimate_krw", "additional_monthly_cash_cost_estimate_krw");
			Map<String, Object> staffingPlan = OperationResultContract.plans(schedule).stream()
					.filter(item -> item.get("choice_key").equals(plan.get("choice_key")))
					.findFirst().orElseThrow();
			row.put("staffing_summary", StaffingSummary.from(staffingPlan, map(simulation.get("comparison_window")),
					map(schedule.getOrDefault("worker_context", Map.of()))));
			summaries.add(row);
		}
		Map<String, Object> summary = new LinkedHashMap<>();
		copy(simulation, summary, "comparison_window", "requested_repetitions", "completed_repetitions",
				"statistics_policy_version", "recommendation", "staffing_schema_version");
		// 화면·확정용 배열은 summary.choices 하나다 (v0.4). labor 원본의 plans는 detail.labor·detail.schedule에 그대로 둔다.
		summary.put("choices", summaries);
		LinkedHashMap<String, Map<String, Object>> warnings = new LinkedHashMap<>();
		LinkedHashSet<String> assumptions = new LinkedHashSet<>();
		for (Map<String, Object> stage : List.of(simulation, schedule, cost)) {
			if (stage.get("warnings") instanceof List<?>) {
				for (Map<String, Object> warning : maps(stage.get("warnings"))) {
					// 경고 ID 허용 목록은 두지 않는다. 필수·참고는 requires_ack로 나눈다 (README · 가드레일 G-D4).
					require(warning.get("warning_id") instanceof String id && !id.isBlank()
							&& warning.get("message") instanceof String && warning.get("requires_ack") instanceof Boolean);
					// 같은 ID에 다른 문구·확인 조건이 오면 하나로 덮어쓰지 않고 계약 오류로 본다.
					Map<String, Object> previous = warnings.putIfAbsent((String) warning.get("warning_id"), warning);
					require(previous == null || previous.equals(warning));
				}
			}
			if (stage.get("assumptions") instanceof List<?> notes) {
				for (Object note : notes) {
					require(note instanceof String);
					assumptions.add((String) note);
				}
			}
		}
		// 운영 결과는 모의 조건 필수 경고가 있어야 확정된다 (GR-24). 도구가 이미 줬다면 필수(true)인지만 확인한다.
		Map<String, Object> simulated = warnings.get(SIMULATED_CONDITIONS);
		if (simulated == null) {
			warnings.put(SIMULATED_CONDITIONS, Map.of("warning_id", SIMULATED_CONDITIONS,
					"message", "모의 조건으로 계산한 결과입니다. 실측 결과가 아닙니다.", "requires_ack", true));
		}
		else {
			require(Boolean.TRUE.equals(simulated.get("requires_ack")));
		}
		summary.put("warnings", new ArrayList<>(warnings.values()));
		summary.put("assumptions", new ArrayList<>(assumptions));
		// 30회 완주·집계(simulation complete)와 세 안의 배치표·비용 연결 검사를 모두 통과한 결과만 여기까지 온다.
		summary.put("complete", true);
		Map<String, Object> detail = new LinkedHashMap<>();
		detail.put("labor", cost);
		detail.put("schedule", schedule);
		detail.put("simulation_choices", OperationResultContract.plans(simulation));
		copy(simulation, detail, "replication_metrics", "metric_definitions", "statistics_policy_version",
				"sensitivity_grid", "sources");
		List<Map<String, Object>> traces = new ArrayList<>();
		if (simulation.get("trace_refs") instanceof List<?>) {
			for (Map<String, Object> ref : maps(simulation.get("trace_refs"))) {
				require(ref.get("result_id") instanceof Number id && id.longValue() == resultId);
				require(OperationResultContract.CHOICES.contains(ref.get("choice_key")));
				int rep = OperationResultContract.integer(ref.get("replication_no"));
				require(rep >= 1 && rep <= 30 && ref.get("log_id") instanceof Number && ref.get("is_complete") instanceof Boolean);
				Map<String, Object> clean = new LinkedHashMap<>();
				copy(ref, clean, "result_id", "log_id", "choice_key", "replication_no", "is_complete");
				traces.add(clean);
			}
		}
		detail.put("trace_refs", traces);
		detail.putIfAbsent("sensitivity_grid", null);
		detail.put("assumptions", new ArrayList<>(assumptions));
		return ApiResponse.ok(Map.of("detail_status", "COMPLETED", "summary", summary, "detail", detail));
	}

	private ApiResponse<Map<String, Object>> save(SessionVersion source, long id, String key,
			ApiResponse<Map<String, Object>> outcome) {
		boolean ok = outcome.status() == ResponseStatus.OK;
		Map<String, Object> summary = ok ? map(outcome.data().get("summary")) : new LinkedHashMap<>(outcome.data());
		if (!ok) {
			// 질문·실패 결과는 확정할 수 없다. 성공 칸을 빈 값으로 고정해 부분 결과를 성공처럼 읽지 않게 한다 (v0.4).
			summary.put("message", outcome.message());
			summary.put("complete", false);
			summary.put("choices", List.of());
			summary.put("recommendation", null);
		}
		String detailStatus = Objects.toString(outcome.data().get("detail_status"), null);
		String detail = ok ? mapper.writeValueAsString(outcome.data().get("detail")) : null;
		StoredResult result = new StoredResult(id, source.inputVersionId(), source.sessionId(), source.versionNo(),
				"operation", outcome.status().getValue(), detailStatus, mapper.writeValueAsString(summary), detail,
				OffsetDateTime.now(), source.currentVersion(), source.ownerKey(), null);
		transaction.executeWithoutResult(status -> {
			requestKeyLock.lock("operation", source.inputVersionId(), key);
			repository.lockSession(source.sessionId());
			var stored = repository.findByRequestKey(source.sessionId(), key);
			if (stored.isPresent()) {
				if (stored.get().inputVersionId() != source.inputVersionId()) {
					throw ApiException.badRequest(CODE_IDEMPOTENCY_KEY_REUSED, KEY_REUSED);
				}
				return;
			}
			repository.insertResult(result, source, key);
			repository.markStep(source.sessionId(), source.versionNo(), ok ? "result" : "review");
		});
		// 계산 도중 입력이 바뀔 수 있으므로 저장 후 현재 버전을 다시 읽는다.
		StoredResult saved = repository.findByRequestKey(source.sessionId(), key).orElse(result);
		return runResponse(ownedResult(saved.resultId(), false));
	}

	public ApiResponse<Map<String, Object>> result(long resultId, String view) {
		if (!Set.of("summary", "detail").contains(view)) {
			throw ApiException.badRequest(CODE_INVALID_REQUEST, "view는 summary 또는 detail만 사용할 수 있습니다.");
		}
		StoredResult row = ownedResult(resultId, "detail".equals(view));
		Map<String, Object> data = metadata(row);
		Map<String, Object> summary = read(row.summaryJson());
		data.put("summary", summary);
		data.put("detail", "ok".equals(row.responseStatus()) && row.detailJson() != null ? read(row.detailJson()) : null);
		return new ApiResponse<>(ResponseStatus.OK, data, (String) summary.get("message"));
	}

	private StoredResult ownedResult(long resultId, boolean detail) {
		return repository.findResult(resultId, detail)
				.filter(row -> "operation".equals(row.featureType()) && owner.key().equals(row.ownerKey()))
				.orElseThrow(() -> ApiException.notFound(CODE_RESULT_NOT_FOUND, "운영 결과를 찾을 수 없습니다."));
	}

	private ApiResponse<Map<String, Object>> runResponse(StoredResult row) {
		Map<String, Object> data = metadata(row);
		Map<String, Object> summary = read(row.summaryJson());
		if ("ok".equals(row.responseStatus())) {
			data.put("summary", summary);
			data.put("detail", null);
			return ApiResponse.ok(data);
		}
		String message = Objects.toString(summary.remove("message"), null);
		data.putAll(summary);
		return new ApiResponse<>(ResponseStatus.from(row.responseStatus()), data, message);
	}

	private Map<String, Object> metadata(StoredResult row) {
        return new OperationResultResponse(row.resultId(), row.sessionId(), row.inputVersionId(), row.versionNo(),
                row.responseStatus(), row.detailStatus(), row.createdAt(), row.versionNo() == row.currentVersion(),
                row.confirmedChoiceKey()).asMap();
	}

	public ApiResponse<Map<String, Object>> trace(long resultId, long logId) {
		StoredResult result = ownedResult(resultId, true);
		if (!"ok".equals(result.responseStatus())) {
			throw ApiException.notFound("재생 기록을 찾을 수 없습니다.");
		}
		var trace = repository.findTrace(resultId, logId)
				.filter(row -> row.resultId() == resultId && row.inputVersionId() == result.inputVersionId()
						&& row.sessionId() == result.sessionId())
				.orElseThrow(() -> ApiException.notFound("재생 기록을 찾을 수 없습니다."));
		try {
			return traceResponse(result, trace);
		}
		catch (AiServerException e) {
			throw new IllegalStateException("저장된 재생 자료의 형식을 확인해 주세요.", e);
		}
	}

	private ApiResponse<Map<String, Object>> traceResponse(StoredResult result, Trace trace) {
		long resultId = result.resultId();
		long logId = trace.logId();
		Map<String, Object> stored = read(trace.payloadJson());
		List<Map<String, Object>> refs = maps(read(result.detailJson()).get("trace_refs"));
		require(refs.stream().anyMatch(ref -> ref.get("log_id") instanceof Number id && id.longValue() == logId
				&& Objects.equals(ref.get("choice_key"), stored.get("choice_key"))
				&& Objects.equals(ref.get("replication_no"), stored.get("replication_no"))
				&& Objects.equals(ref.get("is_complete"), stored.get("is_complete"))));
		require("seconds".equals(stored.get("time_unit")));
		require(stored.get("time_origin") instanceof String origin
				&& origin.matches("(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d)?"));
		if (!OperationResultContract.CHOICES.contains(stored.get("choice_key"))) {
			throw new IllegalStateException("저장된 재생 운영안이 올바르지 않습니다.");
		}
		int rep = OperationResultContract.integer(stored.get("replication_no"));
		int count = OperationResultContract.integer(read(result.summaryJson()).get("completed_repetitions"));
		boolean hasInitialState = stored.get("initial_state") instanceof Map<?, ?>;
		boolean versionTwo = "operation.trace.v2".equals(stored.get("trace_schema_version"));
		if (rep < 1 || rep > count || (!versionTwo && !"operation.trace.v1".equals(stored.get("trace_schema_version")))
				|| (versionTwo && !hasInitialState) || !(stored.get("is_complete") instanceof Boolean)) {
			throw new IllegalStateException("저장된 재생 형식을 확인해 주세요.");
		}
		List<Map<String, Object>> events = new ArrayList<>();
		Set<Integer> sequenceNumbers = new java.util.HashSet<>();
		for (Map<String, Object> event : maps(stored.get("events"))) {
			if (!EVENT_TYPES.contains(event.get("event_type")) || OperationResultContract.number(event.get("at_seconds")) < 0
					|| OperationResultContract.integer(event.get("sequence_no")) <= 0
					|| !sequenceNumbers.add(OperationResultContract.integer(event.get("sequence_no")))) {
				throw new IllegalStateException("저장된 이벤트 순서를 확인해 주세요.");
			}
			Map<String, Object> clean = new LinkedHashMap<>();
			copy(event, clean, "sequence_no", "at_seconds", "event_type", "customer_key", "worker_key");
			events.add(clean);
		}
		require(OperationResultContract.integer(stored.get("event_count")) == events.size());
		events.sort(Comparator.<Map<String, Object>>comparingDouble(event -> ((Number) event.get("at_seconds")).doubleValue())
				.thenComparingInt(event -> ((Number) event.get("sequence_no")).intValue()));
		Map<String, Object> data = new LinkedHashMap<>();
		copy(stored, data, "choice_key", "replication_no", "trace_schema_version", "time_origin", "time_unit",
				"observation_window", "is_complete");
		data.put("result_id", resultId);
		data.put("log_id", logId);
		data.put("session_id", result.sessionId());
		data.put("input_version_id", result.inputVersionId());
		data.put("initial_state", hasInitialState ? cleanInitialState(map(stored.get("initial_state"))) : null);
		data.put("event_count", events.size());
		data.put("events", events);
		return ApiResponse.ok(data);
	}

	private static Map<String, Object> cleanInitialState(Map<String, Object> source) {
		Map<String, Object> state = new LinkedHashMap<>();
		copy(source, state, "active_staff_keys", "order_queue", "preparation_queue", "completed_customer_count");
		for (String key : List.of("active_staff_keys", "order_queue", "preparation_queue")) {
			require(state.get(key) instanceof List<?> strings && strings.stream().allMatch(item -> item instanceof String));
		}
		require(OperationResultContract.integer(state.get("completed_customer_count")) >= 0);
		for (String group : List.of("customers", "in_service")) {
			List<Map<String, Object>> rows = new ArrayList<>();
			for (Map<String, Object> row : maps(source.getOrDefault(group, List.of()))) {
				require(row.get("customer_key") instanceof String);
				String key = group.equals("customers") ? "state" : "stage";
				require(Set.of("ORDER_QUEUE", "ORDERING", "WAITING_PREPARATION", "PREPARING", "WAITING_HANDOFF",
						"DONE").contains(row.get(key)));
				Map<String, Object> clean = new LinkedHashMap<>();
				copy(row, clean, "customer_key", "worker_key", "state", "stage");
				rows.add(clean);
			}
			state.put(group, rows);
		}
		return state;
	}

	private ApiResponse<Map<String, Object>> remapMissing(ApiResponse<Map<String, Object>> response, String prefix) {
		if (response.status() != ResponseStatus.NEEDS_INPUT || !response.data().containsKey("missing_fields")) {
			return response;
		}
		Map<String, Object> data = new LinkedHashMap<>(response.data());
		List<Map<String, Object>> fields = new ArrayList<>();
		for (Map<String, Object> field : maps(data.get("missing_fields"))) {
			Map<String, Object> copy = new LinkedHashMap<>(field);
			String path = String.valueOf(field.get("path"));
			copy.put("path", Set.of("business_date", "wage_year", "assumptions_version").contains(path)
					? path : prefix + "." + path);
			fields.add(copy);
		}
		data.put("missing_fields", fields);
		return new ApiResponse<>(response.status(), data, response.message());
	}

	private Map<String, Object> read(String json) {
		return json == null ? new LinkedHashMap<>() : mapper.readValue(json, JSON_MAP);
	}

	private static void copy(Map<String, Object> source, Map<String, Object> target, String... keys) {
		for (String key : keys) {
			if (source.containsKey(key)) {
				target.put(key, source.get(key));
			}
		}
	}
}
