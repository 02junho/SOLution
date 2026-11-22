package com.solution.operation.service.roster;

import java.time.Duration;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.common.response.ApiResponse;
import com.solution.operation.service.OperationResultRepository;
import com.solution.operation.service.OperationResultRepository.SessionVersion;
import com.solution.operation.service.OperationResultRepository.StoredResult;
import com.solution.session.service.CalculationRuns;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * 추천 근무표 3안을 업무 결과(work_result)로 저장한다. 운영 2번(가게 데이터 버전) 확장. DB 스키마 변경 없음.
 *
 * <p>흐름: 실험실이 업무를 만들고 입력을 저장·확인한 뒤 이 API로 요일별 조건과 직원 명단을 보낸다. 서버가 ai-server로 다시
 * 계산해(화면이 보낸 결과는 믿지 않는다) 세 안을 choices로 저장한다. 사장님이 고른 안은 공통 확정 API
 * (/work-results/{id}/confirm)로 저장하고, "저장한 계획"에서 다시 볼 수 있다.
 *
 * <p>계산은 1~2분 걸려서 뒤에서 한다: 시작 요청은 바로 RUNNING을 돌려주고, 화면은 상태 조회로 끝났는지 본다.
 * 화면을 나가거나 폰 화면이 꺼져도 계산은 계속되고 결과는 업무에 저장된다. 계산 중 표시는 공통 CalculationRuns를
 * 그대로 쓴다(서버가 꺼지면 임대가 만료돼 정리된다).
 *
 * <p>부하·과금 안전장치(작은 배포 서버 기준): 동시에 도는 계산은 .env의 OPERATION_ROSTER_MAX_PARALLEL개(기본 2),
 * 기다리는 계산은 MAX_QUEUED개까지. 그보다 많이 오면 새 요청은 "잠시 뒤 다시"로 거절한다(무한히 쌓이지 않게).
 * 실패 기록은 FAILED_KEEP 뒤 지운다.
 *
 * <p>summary_json은 공통 확정이 읽는 모양을 따른다: complete, choices[choice_key], warnings[SIMULATED_CONDITIONS 필수 확인].
 * result_kind = ROSTER_OPTIONS로 세 운영안 비교 결과와 구분한다.
 */
@Service
public class RosterResultService {

	static final String RESULT_KIND = "ROSTER_OPTIONS";
	static final String SIMULATED_CONDITIONS = "SIMULATED_CONDITIONS";
	static final String UNFILLED_SHIFTS = "UNFILLED_SHIFTS";
	/** 동시에 도는 계산 수 기본값. ai-server가 요일을 동시에 계산해서 여러 건을 같이 돌리면 다 느려진다. */
	static final int DEFAULT_PARALLEL = 2;
	/** 동시 계산이 다 차 있을 때 기다릴 수 있는 계산 수. 넘으면 거절한다. */
	static final int MAX_QUEUED = 4;
	/** 실패 기록을 남겨 두는 시간(화면이 "다시 계산" 안내를 받을 수 있을 만큼). */
	static final Duration FAILED_KEEP = Duration.ofHours(1);
	private static final Logger log = LoggerFactory.getLogger(RosterResultService.class);
	private static final TypeReference<LinkedHashMap<String, Object>> JSON_MAP = new TypeReference<>() { };

	/** 이 서버에서 시작한 계산의 상태(요청 키별). 서버가 다시 켜지면 비고, 그때는 DB 결과와 계산 중 표시로 판단한다. */
	private record Job(long sessionId, long versionId, String state, String message, Instant at) {
	}

	private final Map<String, Job> jobs = new ConcurrentHashMap<>();
	private final Executor executor;
	private final CalculationRuns runs;

	private final DailyRosterService rosters;
	private final OperationResultRepository repository;
	private final CurrentOwner owner;
	private final IdGenerator ids;
	private final ObjectMapper mapper;
	private final TransactionTemplate transaction;
	private final RequestKeyLock requestKeyLock;

	@Autowired
	public RosterResultService(DailyRosterService rosters, OperationResultRepository repository, CurrentOwner owner,
			IdGenerator ids, ObjectMapper mapper, TransactionTemplate transaction, RequestKeyLock requestKeyLock,
			CalculationRuns runs, @Value("${OPERATION_ROSTER_MAX_PARALLEL:" + DEFAULT_PARALLEL + "}") int maxParallel) {
		this(rosters, repository, owner, ids, mapper, transaction, requestKeyLock, runs, pool(maxParallel));
	}

	/** 테스트는 바로 실행하는 실행기를 넣는다. */
	RosterResultService(DailyRosterService rosters, OperationResultRepository repository, CurrentOwner owner,
			IdGenerator ids, ObjectMapper mapper, TransactionTemplate transaction, RequestKeyLock requestKeyLock,
			CalculationRuns runs, Executor executor) {
		this.runs = runs;
		this.executor = executor;
		this.rosters = rosters;
		this.repository = repository;
		this.owner = owner;
		this.ids = ids;
		this.mapper = mapper;
		this.transaction = transaction;
		this.requestKeyLock = requestKeyLock;
	}

	static ExecutorService pool(int maxParallel) {
		int size = Math.max(1, Math.min(4, maxParallel));
		AtomicInteger count = new AtomicInteger();
		// 기다리는 줄을 MAX_QUEUED로 막아 두면 넘칠 때 RejectedExecutionException이 난다(start에서 "잠시 뒤 다시"로 바꾼다).
		return new ThreadPoolExecutor(size, size, 0, TimeUnit.MILLISECONDS, new LinkedBlockingQueue<>(MAX_QUEUED), task -> {
			Thread thread = new Thread(task, "roster-options-" + count.incrementAndGet());
			thread.setDaemon(true);
			return thread;
		});
	}

	@PreDestroy
	void shutdown() {
		if (executor instanceof ExecutorService pool) {
			pool.shutdownNow();
		}
	}

	/**
	 * 계산 시작. 요청: {"input_version_id", "days", "workers", "min_gain_sec"(선택), "compare_holiday_pay"(선택)}, 요청 키 필수.
	 * 같은 요청 키로 다시 보내면 새로 시작하지 않고 지금 상태(RUNNING / DONE / FAILED)를 돌려준다.
	 */
	public ApiResponse<Map<String, Object>> start(long sessionId, Map<String, Object> body, String requestKey) {
		if (requestKey == null || requestKey.isBlank() || !requestKey.matches("[\\x20-\\x7E]{1,100}")) {
			throw ApiException.badRequest("INVALID_REQUEST", "Idempotency-Key는 1~100자의 요청 키여야 합니다.");
		}
		if (!(body.get("input_version_id") instanceof Number version)) {
			throw ApiException.badRequest("INVALID_REQUEST", "input_version_id를 보내 주세요.");
		}
		long versionId = version.longValue();
		checked(sessionId, versionId);
		forgetOldFailures();
		var existing = repository.findByRequestKey(sessionId, requestKey);
		if (existing.isPresent()) {
			return done(existing.get(), versionId);
		}
		synchronized (jobs) {
			Job job = jobs.get(requestKey);
			if (job != null) {
				if (job.sessionId() != sessionId || job.versionId() != versionId) {
					throw ApiException.badRequest("IDEMPOTENCY_KEY_REUSED", "같은 요청키로 다른 내용을 보낼 수 없습니다.");
				}
				return state(job, requestKey);
			}
			// 계산 중 표시를 먼저 남기고(실패하면 시작하지 않음) 뒤에서 계산한다.
			CalculationRuns.Run run = runs.start(sessionId, "operation", () -> checked(sessionId, versionId));
			repository.markStep(sessionId, checked(sessionId, versionId).versionNo(), "running");
			Job running = new Job(sessionId, versionId, "RUNNING", null, Instant.now());
			jobs.put(requestKey, running);
			try {
				executor.execute(() -> compute(run, sessionId, versionId, body, requestKey));
			} catch (RejectedExecutionException full) {
				jobs.remove(requestKey);
				run.close();
				throw ApiException.badRequest("CALCULATION_BUSY", "지금 계산이 많이 밀려 있어요. 잠시 뒤 다시 해 주세요.");
			} catch (RuntimeException failure) {
				jobs.remove(requestKey);
				run.close();
				throw failure;
			}
			return state(running, requestKey);
		}
	}

	/** 상태 조회: DB에 결과가 있으면 DONE, 이 서버에서 도는 중이면 RUNNING, 실패했으면 FAILED, 어디에도 없으면 LOST. */
	public ApiResponse<Map<String, Object>> status(long sessionId, long versionId, String requestKey) {
		if (requestKey == null || requestKey.isBlank()) {
			throw ApiException.badRequest("INVALID_REQUEST", "request_key를 보내 주세요.");
		}
		owned(sessionId, versionId);
		forgetOldFailures();
		var existing = repository.findByRequestKey(sessionId, requestKey);
		if (existing.isPresent()) {
			return done(existing.get(), versionId);
		}
		Job job = jobs.get(requestKey);
		if (job != null && job.sessionId() == sessionId) {
			return state(job, requestKey);
		}
		// 서버가 다시 켜졌거나 다른 서버에서 시작한 계산: 결과도 기록도 없으면 다시 계산해야 한다.
		return state(new Job(sessionId, versionId, "LOST", "계산 기록을 찾지 못했어요. 다시 계산해 주세요.", Instant.now()), requestKey);
	}

	/** 실패 기록은 FAILED_KEEP이 지나면 지운다(서버 메모리에 계속 쌓이지 않게). */
	private void forgetOldFailures() {
		Instant cutoff = Instant.now().minus(FAILED_KEEP);
		jobs.entrySet().removeIf(entry -> "FAILED".equals(entry.getValue().state()) && entry.getValue().at().isBefore(cutoff));
	}

	/** 지금 이 서버에서 도는 진짜 계산 수. 미리 계산(RosterWarmService)은 이 값이 0일 때만 시작한다. */
	public long runningCount() {
		return jobs.values().stream().filter(job -> "RUNNING".equals(job.state())).count();
	}

	/** 테스트용: 지금 남아 있는 기록 수. */
	int jobCount() {
		return jobs.size();
	}

	private void compute(CalculationRuns.Run run, long sessionId, long versionId, Map<String, Object> body, String key) {
		try (run) {
			Map<String, Object> options = rosters.rosterOptions(body).data();
			run.requireActive();
			save(sessionId, versionId, options, body, key);
			jobs.remove(key);
		} catch (RuntimeException failure) {
			log.warn("추천 근무표 계산 실패 session={} key={}", sessionId, key, failure);
			String message = failure instanceof ApiException api ? api.getMessage() : "추천 근무표를 만들지 못했어요. 다시 계산해 주세요.";
			jobs.put(key, new Job(sessionId, versionId, "FAILED", message, Instant.now()));
		}
	}

	private void save(long sessionId, long versionId, Map<String, Object> options, Map<String, Object> body, String key) {
		SessionVersion source = checked(sessionId, versionId);
		StoredResult row = new StoredResult(ids.next(), versionId, sessionId, source.versionNo(), "operation", "ok", null,
				write(summary(options)), write(detail(options, body)), OffsetDateTime.now(), source.currentVersion(),
				source.ownerKey(), null);
		transaction.executeWithoutResult(status -> {
			requestKeyLock.lock("operation", versionId, key);
			repository.lockSession(sessionId);
			SessionVersion latest = checked(sessionId, versionId);
			if (repository.findByRequestKey(sessionId, key).isEmpty()) {
				repository.insertResult(row, latest, key);
				repository.markStep(sessionId, latest.versionNo(), "result");
			}
		});
	}

	private ApiResponse<Map<String, Object>> state(Job job, String key) {
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("state", job.state());
		data.put("request_key", key);
		data.put("session_id", job.sessionId());
		data.put("input_version_id", job.versionId());
		return new ApiResponse<>(com.solution.common.response.ResponseStatus.OK, data, job.message());
	}

	private SessionVersion owned(long sessionId, long versionId) {
		SessionVersion source = repository.findSessionVersion(sessionId, versionId)
				.filter(row -> "operation".equals(row.featureType()) && owner.key().equals(row.ownerKey()))
				.orElseThrow(() -> ApiException.notFound("SESSION_NOT_FOUND", "운영 업무를 찾을 수 없습니다."));
		if (source.inputVersionId() == null) {
			throw ApiException.notFound("SESSION_NOT_FOUND", "입력 버전을 찾을 수 없습니다.");
		}
		return source;
	}

	private SessionVersion checked(long sessionId, long versionId) {
		SessionVersion source = owned(sessionId, versionId);
		if (!Objects.equals(source.versionNo(), source.currentVersion())) {
			throw ApiException.badRequest("STALE_VERSION", "조건이 바뀌었어요. 최신 입력을 확인한 뒤 계산해 주세요.");
		}
		if (source.inputConfirmedAt() == null) {
			throw ApiException.badRequest("INPUT_NOT_CONFIRMED", "입력을 먼저 확인해 주세요.");
		}
		return source;
	}

	private ApiResponse<Map<String, Object>> done(StoredResult row, long versionId) {
		if (row.inputVersionId() != versionId) {
			throw ApiException.badRequest("IDEMPOTENCY_KEY_REUSED", "같은 요청키로 다른 내용을 보낼 수 없습니다.");
		}
		Map<String, Object> summary = read(row.summaryJson());
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("state", "DONE");
		data.put("result_id", row.resultId());
		data.put("session_id", row.sessionId());
		data.put("input_version_id", row.inputVersionId());
		data.put("version_no", row.versionNo());
		data.put("summary", summary);
		return new ApiResponse<>(com.solution.common.response.ResponseStatus.OK, data, (String) summary.get("message"));
	}

	/** 공통 확정이 읽는 요약. 안마다 숫자만 담고, 근무표 전체는 detail에 둔다. */
	@SuppressWarnings("unchecked")
	static Map<String, Object> summary(Map<String, Object> options) {
		List<Map<String, Object>> choices = new ArrayList<>();
		List<String> short15 = new ArrayList<>();
		Map<String, Object> recommended = null;
		Map<String, Object> save = null;
		for (Object item : (List<Object>) options.get("options")) {
			Map<String, Object> option = (Map<String, Object>) item;
			Map<String, Object> weekly = (Map<String, Object>) option.get("weekly");
			Map<String, Object> shortfall = (Map<String, Object>) option.get("shortfall");
			Map<String, Object> choice = new LinkedHashMap<>();
			String key = (String) option.get("key");
			choice.put("choice_key", key);
			choice.put("title", option.get("title"));
			choice.put("extra_by_day", option.get("extra_by_day"));
			choice.put("peak_wait_sec", average((Map<String, Object>) option.get("peak_wait_sec")));
			choice.put("weekly_cost_krw", option.get("plan_cost_krw"));
			choice.put("people_used", weekly.get("people_used"));
			choice.put("unfilled_hours", shortfall.get("unfilled_hours"));
			choice.put("more_people_under_15h", shortfall.get("more_people_under_15h"));
			choices.add(choice);
			if (((Number) shortfall.get("more_people_under_15h")).intValue() > 0) {
				short15.add(key);
			}
			if ("RECOMMENDED".equals(key)) {
				recommended = choice;
			}
			if ("SAVE".equals(key)) {
				save = choice;
			}
		}
		List<Map<String, Object>> warnings = new ArrayList<>();
		warnings.add(warning(SIMULATED_CONDITIONS, true, null,
				"가게 데이터로 만든 평균 하루를 30번씩 돌린 계획 근무표예요. 실제 근무 기록이 아니에요."));
		if (!short15.isEmpty()) {
			warnings.add(warning(UNFILLED_SHIFTS, true, short15,
					"직원 명단으로 다 못 채운 자리가 있어요. 알바를 더 구하거나 가능 시간을 넓혀야 해요."));
		}
		Map<String, Object> holiday = (Map<String, Object>) options.get("holiday_compare");
		Map<String, Object> summary = new LinkedHashMap<>();
		summary.put("result_kind", RESULT_KIND);
		summary.put("model_version", options.get("model_version"));
		summary.put("complete", true);
		summary.put("recommended_choice_key", "RECOMMENDED");
		summary.put("choices", choices);
		summary.put("warnings", warnings);
		// 주휴 비교를 안 했으면(쉬운 화면) 요약에도 넣지 않는다.
		if (holiday != null) {
			summary.put("holiday_compare", Map.of("choice_key", "RECOMMENDED", "weekly_cost_krw", holiday.get("plan_cost_krw"),
					"people_used", ((Map<String, Object>) holiday.get("weekly")).get("people_used")));
		}
		summary.put("message", message(Objects.requireNonNull(recommended), Objects.requireNonNull(save)));
		return summary;
	}

	/** 추천안 한 줄 요약. 문구는 값으로 만든다(LLM 아님). */
	static String message(Map<String, Object> recommended, Map<String, Object> save) {
		StringBuilder text = new StringBuilder("추천안: ");
		Object wait = recommended.get("peak_wait_sec");
		Object baseWait = save.get("peak_wait_sec");
		text.append("바쁜 시간 대기 ");
		if (baseWait instanceof Number base && wait instanceof Number now && base.doubleValue() != now.doubleValue()) {
			text.append(minutes(base)).append(" → ").append(minutes(now));
		} else {
			text.append(wait instanceof Number now ? minutes(now) : "—");
		}
		text.append(", 주 인건비 ").append(won(recommended.get("weekly_cost_krw")));
		text.append(", 알바 ").append(recommended.get("people_used")).append("명(모두 주 15시간 미만)");
		if (((Number) recommended.get("more_people_under_15h")).intValue() > 0) {
			text.append(", 알바 ").append(recommended.get("more_people_under_15h")).append("명 더 필요");
		}
		return text.append('.').toString();
	}

	private static String minutes(Number sec) {
		return String.format("%.1f분", sec.doubleValue() / 60);
	}

	private static String won(Object value) {
		return value instanceof Number n ? String.format("%,d원", n.longValue()) : "—";
	}

	private static Double average(Map<String, Object> byDay) {
		List<Double> values = byDay.values().stream().filter(Number.class::isInstance)
				.map(v -> ((Number) v).doubleValue()).toList();
		return values.isEmpty() ? null : Math.round(values.stream().mapToDouble(Double::doubleValue).average().orElseThrow() * 10) / 10.0;
	}

	private static Map<String, Object> warning(String id, boolean ack, List<String> keys, String message) {
		Map<String, Object> warning = new LinkedHashMap<>();
		warning.put("warning_id", id);
		warning.put("requires_ack", ack);
		warning.put("choice_keys", keys);
		warning.put("message", message);
		return warning;
	}

	/** 안마다 요일별 근무표·주간 배정 전체 + 더하기 비교 + 계산에 쓴 조건(다시 볼 때 같은 화면을 그린다). */
	@SuppressWarnings("unchecked")
	static Map<String, Object> detail(Map<String, Object> options, Map<String, Object> body) {
		Map<String, Object> detail = new LinkedHashMap<>();
		List<Map<String, Object>> choices = new ArrayList<>();
		for (Object item : (List<Object>) options.get("options")) {
			Map<String, Object> choice = new LinkedHashMap<>((Map<String, Object>) item);
			choice.put("choice_key", choice.remove("key"));
			choices.add(choice);
		}
		detail.put("choices", choices);
		detail.put("days", options.get("days"));
		detail.put("holiday_compare", options.get("holiday_compare"));
		detail.put("skipped_days", options.get("skipped_days"));
		detail.put("assumptions", options.get("assumptions"));
		detail.put("min_gain_sec", options.get("min_gain_sec"));
		Map<String, Object> request = new LinkedHashMap<>();
		request.put("days", body.get("days"));
		request.put("workers", body.get("workers"));
		// 다시 불러와 계산할 때 같은 조건으로 돌리게 선택 값도 남긴다.
		for (String key : List.of("min_gain_sec", "compare_holiday_pay")) {
			if (body.get(key) != null) {
				request.put(key, body.get(key));
			}
		}
		detail.put("request", request);
		return detail;
	}

	private String write(Object value) {
		return mapper.writeValueAsString(value);
	}

	private Map<String, Object> read(String json) {
		return mapper.readValue(json, JSON_MAP);
	}
}
