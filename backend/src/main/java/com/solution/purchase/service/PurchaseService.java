package com.solution.purchase.service;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.session.service.CalculationRuns;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.purchase.service.PurchaseRepository.SessionVersion;
import com.solution.purchase.service.PurchaseRepository.StoredResult;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * 구매안 계산 실행·상세 조회 (노션 API 명세서 "구매안 계산 실행", "구매안 상세 조회").
 *
 * <p>흐름: 화면 → Spring(입력 버전 검사) → FastAPI POST /tools/purchase → Spring이 work_result 저장 → 화면.
 * 계산에 쓰는 숫자는 저장된 work_version.input_json에서만 읽는다. 화면이 보낸 숫자는 쓰지 않는다.
 */
@Service
public class PurchaseService {

	static final String TOOL_PATH = "/tools/purchase";
	static final String SESSION_NOT_FOUND = "매입 업무를 찾을 수 없습니다.";
	static final String RESULT_NOT_FOUND = "구매안 결과를 찾을 수 없습니다.";
	static final String NOT_LATEST = "조건이 바뀌었어요. 최신 조건으로 다시 계산해 주세요.";
	static final String NOT_CONFIRMED = "입력을 먼저 확인해 주세요.";

	// 오류 사유 코드 (data.detail_code). 입력 확인 API·확정 API와 같은 이름을 쓴다 (상태코드·경고 점검 공유사항 11.17).
	static final String CODE_SESSION_NOT_FOUND = "SESSION_NOT_FOUND";
	static final String CODE_RESULT_NOT_FOUND = "RESULT_NOT_FOUND";
	static final String CODE_STALE_VERSION = "STALE_VERSION";
	static final String CODE_INPUT_NOT_CONFIRMED = "INPUT_NOT_CONFIRMED";

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> MAP_RESPONSE =
			new ParameterizedTypeReference<>() {
			};
	private static final TypeReference<LinkedHashMap<String, Object>> MAP_TYPE = new TypeReference<>() {
	};

	private final CalculationRuns runs;
	private final PurchaseRepository repository;
	private final AiServerClient aiServerClient;
	private final CurrentOwner currentOwner;
	private final IdGenerator idGenerator;
	private final RequestKeyLock requestKeyLock;
	private final ObjectMapper objectMapper;
	private final TransactionTemplate transactionTemplate;

	public PurchaseService(PurchaseRepository repository, AiServerClient aiServerClient, CurrentOwner currentOwner,
			IdGenerator idGenerator, RequestKeyLock requestKeyLock, ObjectMapper objectMapper,
			TransactionTemplate transactionTemplate, CalculationRuns runs) {
		this.runs = runs;
		this.repository = repository;
		this.aiServerClient = aiServerClient;
		this.currentOwner = currentOwner;
		this.idGenerator = idGenerator;
		this.requestKeyLock = requestKeyLock;
		this.objectMapper = objectMapper;
		this.transactionTemplate = transactionTemplate;
	}

	public ApiResponse<Map<String, Object>> run(long sessionId, long inputVersionId, String requestKeyOrNull) {
		SessionVersion source = repository.findSessionVersion(sessionId, inputVersionId)
				.filter(row -> "purchase".equals(row.featureType()))
				.filter(row -> currentOwner.key().equals(row.ownerKey()))
				.filter(row -> row.inputVersionId() != null)
				.orElseThrow(() -> ApiException.notFound(CODE_SESSION_NOT_FOUND, SESSION_NOT_FOUND));
		// 옛 조건 혼입 차단(GR-04) → 입력 확인 전 계산 차단(GR-09) 순서로 검사한다.
		if (!Objects.equals(source.versionNo(), source.currentVersion())) {
			throw ApiException.badRequest(CODE_STALE_VERSION, NOT_LATEST);
		}
		if (source.inputConfirmedAt() == null) {
			throw ApiException.badRequest(CODE_INPUT_NOT_CONFIRMED, NOT_CONFIRMED);
		}

		String requestKey = (requestKeyOrNull == null || requestKeyOrNull.isBlank())
				? AiServerClient.newRequestKey() : requestKeyOrNull;
		var existing = repository.findByRequestKey(inputVersionId, requestKey);
		if (existing.isPresent()) {
			return runResponse(existing.get());
		}

		Map<String, Object> body = readMap(source.inputJson());
		body.put("store_id", source.storeId());
		body.put("session_id", source.sessionId());
		body.put("input_version_id", source.inputVersionId());

		try (var run = runs.start(sessionId, "purchase", () -> {
			repository.lockSession(sessionId);
			var latest = repository.findSessionVersion(sessionId, inputVersionId)
				.filter(row -> "purchase".equals(row.featureType()) && currentOwner.key().equals(row.ownerKey()))
				.orElseThrow(() -> ApiException.notFound(CODE_SESSION_NOT_FOUND, SESSION_NOT_FOUND));
			if (!Objects.equals(latest.versionNo(), latest.currentVersion())) throw ApiException.badRequest(CODE_STALE_VERSION, NOT_LATEST);
			if (latest.inputConfirmedAt() == null) throw ApiException.badRequest(CODE_INPUT_NOT_CONFIRMED, NOT_CONFIRMED);
		})) {
			ApiResponse<Map<String, Object>> tool = aiServerClient.post(TOOL_PATH, body, requestKey, MAP_RESPONSE);
			if (tool == null || tool.status() == null || tool.status() == ResponseStatus.ERROR || tool.data() == null) {
				throw new AiServerException("AI 서버가 계산 결과를 돌려주지 않았습니다: " + TOOL_PATH);
			}

			Map<String, Object> data = tool.data();
			boolean ok = tool.status() == ResponseStatus.OK;
			Map<String, Object> summary;
			Object detail;
			if (ok) {
				summary = asMap(data.get("summary"));
				detail = data.get("detail");
			}
			else {
				// needs_input·infeasible은 data 전체를 요약으로 저장한다. 재전송 때 같은 문구를 돌려주려고 message도 함께 둔다.
				summary = new LinkedHashMap<>(data);
				summary.put("message", tool.message());
				detail = null;
			}

			long resultId = idGenerator.next();
			OffsetDateTime createdAt = OffsetDateTime.now();
			String detailStatus = data.get("detail_status") == null ? null : String.valueOf(data.get("detail_status"));
			String summaryJson = writeJson(summary);
			String detailJson = detail == null ? null : writeJson(detail);
			// 같은 요청 키가 동시에 두 번 오면 둘 다 계산까지는 갈 수 있다(같은 입력이면 결과도 같다).
			// work_result.request_key에는 UQ가 없으므로(ERD) 저장 직전에 잠그고 다시 확인해 결과를 하나만 남긴다 (RequestKeyLock).
			StoredResult saved = transactionTemplate.execute(status -> {
				requestKeyLock.lock("purchase", source.inputVersionId(), requestKey);
				repository.lockSession(sessionId);
				run.requireActive();
				var current = repository.findSessionVersion(sessionId, inputVersionId)
						.filter(row -> currentOwner.key().equals(row.ownerKey()))
						.orElseThrow(() -> ApiException.notFound(CODE_SESSION_NOT_FOUND, SESSION_NOT_FOUND));
				var stored = repository.findByRequestKey(source.inputVersionId(), requestKey);
				if (stored.isPresent()) {
					return stored.get();
				}
				// 계산하는 사이 조건이 바뀌어 새 버전이 생겼으면 옛 버전 결과로 업무 단계를 덮지 않는다.
				if (!Objects.equals(current.versionNo(), current.currentVersion())) throw ApiException.badRequest(CODE_STALE_VERSION, NOT_LATEST);
				repository.insertResult(resultId, source, requestKey, tool.status().getValue(), detailStatus,
						summaryJson, detailJson, createdAt);
				if (ok) {
					repository.markSessionResult(source.sessionId());
				}
				return new StoredResult(resultId, source.inputVersionId(), source.sessionId(), source.versionNo(),
						"purchase", tool.status().getValue(), detailStatus, summaryJson, detailJson, createdAt,
						source.currentVersion(), source.ownerKey(), null);
			});
			return runResponse(saved);
		}
	}

	public ApiResponse<Map<String, Object>> detail(long resultId) {
		StoredResult result = repository.findResult(resultId)
				.filter(row -> currentOwner.key().equals(row.ownerKey()))
				.orElseThrow(() -> ApiException.notFound(CODE_RESULT_NOT_FOUND, RESULT_NOT_FOUND));

		Map<String, Object> data = new LinkedHashMap<>();
		data.put("result_id", result.resultId());
		data.put("session_id", result.sessionId());
		data.put("input_version_id", result.inputVersionId());
		data.put("version_no", result.versionNo());
		data.put("response_status", result.responseStatus());
		data.put("detail_status", result.detailStatus());
		data.put("created_at", result.createdAt());
		data.put("is_latest_version", result.versionNo() == result.currentVersion());
		data.put("confirmed_choice_key", result.confirmedChoiceKey());
		data.put("summary", readMap(result.summaryJson()));
		data.put("detail", result.detailJson() == null ? null : readMap(result.detailJson()));
		return ApiResponse.ok(data);
	}

	/** 계산 실행 응답. ok는 비교 카드용 요약만, needs_input·infeasible은 질문·완화 제안에 쓸 값을 그대로 돌려준다. */
	private ApiResponse<Map<String, Object>> runResponse(StoredResult result) {
		ResponseStatus status = ResponseStatus.from(result.responseStatus());
		Map<String, Object> stored = readMap(result.summaryJson());
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("result_id", result.resultId());
		if (status == ResponseStatus.OK) {
			data.put("session_id", result.sessionId());
			data.put("input_version_id", result.inputVersionId());
			data.put("version_no", result.versionNo());
			data.put("detail_status", result.detailStatus());
			data.put("created_at", result.createdAt());
			data.put("summary", stored);
			return ApiResponse.ok(data);
		}
		Object message = stored.remove("message");
		data.put("input_version_id", result.inputVersionId());
		data.put("detail_status", result.detailStatus());
		stored.remove("detail_status");
		data.putAll(stored);
		String text = message == null ? null : String.valueOf(message);
		return status == ResponseStatus.NEEDS_INPUT ? ApiResponse.needsInput(data, text)
				: ApiResponse.infeasible(data, text);
	}

	private Map<String, Object> readMap(String json) {
		return json == null ? new LinkedHashMap<>() : objectMapper.readValue(json, MAP_TYPE);
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> asMap(Object value) {
		return value instanceof Map<?, ?> map ? new LinkedHashMap<>((Map<String, Object>) map) : new LinkedHashMap<>();
	}

	private String writeJson(Object value) {
		return objectMapper.writeValueAsString(value);
	}
}
