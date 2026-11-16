package com.solution.session.service;

import java.nio.charset.StandardCharsets;
import java.math.BigDecimal;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.OffsetDateTime;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.UUID;
import java.util.regex.Pattern;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.WorkSessionEventRequest;
import com.solution.session.service.SessionRepository.SessionContextRow;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * 대화·폼·질문답변 처리. Spring은 권한·최신성·이벤트 저장을, FastAPI는 해석을 맡는다.
 * LLM 호출은 DB 잠금 밖에서 수행하고, 저장 전에 버전과 요청키를 다시 확인한다.
 * AI의 ok 응답은 parsed_input.input에 계산에 사용할 전체 입력 스냅샷을 포함해야 한다.
 * changed/note만 있는 설명 응답으로는 입력 버전을 만들거나 성공을 반환하지 않는다.
 */
@Service
public class WorkSessionEventService {

	static final String SESSION_NOT_FOUND = "업무를 찾을 수 없습니다.";
	static final String AGENT_PATH = "/agent/interpret";
	private static final String STALE_INPUT = "조건이 바뀌었어요. 최신 입력을 불러온 뒤 다시 보내 주세요.";
	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> MAP_RESPONSE =
			new ParameterizedTypeReference<>() {};
	private static final TypeReference<LinkedHashMap<String, Object>> MAP_TYPE = new TypeReference<>() {};
	private static final TypeReference<ApiResponse<Map<String, Object>>> RESPONSE_TYPE = new TypeReference<>() {};
	private static final Pattern PHONE = Pattern.compile("(?<!\\d)(?:01[016-9]|02|0[3-6][1-5])[-\\s]?\\d{3,4}[-\\s]?\\d{4}(?!\\d)");
	private static final Pattern EMAIL = Pattern.compile("[\\w.+-]+@[\\w-]+\\.[\\w.-]+");
	private static final Pattern NAMED_PERSON = Pattern.compile("((?:담당자|성함|이름)\\s*[:：=]?\\s*)[가-힣]{2,4}");
	private static final List<String> PRIVATE_FIELDS = List.of("phone", "phone_number", "email", "person_name",
			"contact_name", "customer_name", "owner_name", "전화번호", "이메일", "담당자", "성함");

	private final SessionRepository repository;
	private final AiServerClient aiServerClient;
	private final CurrentOwner currentOwner;
	private final IdGenerator idGenerator;
	private final ObjectMapper objectMapper;
	private final TransactionTemplate transactionTemplate;

	public WorkSessionEventService(SessionRepository repository, AiServerClient aiServerClient,
			CurrentOwner currentOwner, IdGenerator idGenerator, ObjectMapper objectMapper,
			TransactionTemplate transactionTemplate) {
		this.repository = repository;
		this.aiServerClient = aiServerClient;
		this.currentOwner = currentOwner;
		this.idGenerator = idGenerator;
		this.objectMapper = objectMapper;
		this.transactionTemplate = transactionTemplate;
	}

	private record Prepared(SessionContextRow context, ApiResponse<Map<String, Object>> response,
			Map<String, Object> question) {}

	public ApiResponse<Map<String, Object>> handleEvent(long sessionId, String suppliedKey,
			WorkSessionEventRequest request) {
		// 권한 검사는 요청 내용·키의 유효성보다 먼저 한다.
		ownedContext(sessionId);
		String requestKey = suppliedKey == null || suppliedKey.isBlank() ? AiServerClient.newRequestKey() : suppliedKey;
		if (requestKey.length() > 150) {
			throw ApiException.badRequest("요청 키는 150자 이하여야 합니다.");
		}
		validate(request);
		String fingerprint = fingerprint(request);
		Prepared prepared = transactionTemplate.execute(status -> {
			repository.lockSession(sessionId);
			SessionContextRow ctx = ownedContext(sessionId);
			ApiResponse<Map<String, Object>> replay = replay(sessionId, requestKey, fingerprint);
			if (replay != null) {
				return new Prepared(ctx, replay, null);
			}
			if ("form".equals(request.eventType())) {
				if (request.baseVersionId() != null && !Objects.equals(request.baseVersionId(), ctx.currentVersionId())) {
					throw ApiException.badRequest(STALE_INPUT);
				}
				Map<String, Object> input = cleanMap(request.formInput());
				return new Prepared(ctx, saveInput(ctx, requestKey, fingerprint, "form", "(폼 입력)", input,
						Map.of("source", "form", "input", input), List.of(), List.of()), null);
			}
			Map<String, Object> question = "question_reply".equals(request.eventType()) ? question(ctx, request) : null;
			return new Prepared(ctx, null, question);
		});
		if (prepared.response() != null) {
			return prepared.response();
		}

		SessionContextRow ctx = prepared.context();
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("session_id", sessionId);
		body.put("store_id", ctx.storeId());
		body.put("feature_type", ctx.featureType());
		body.put("event_type", request.eventType());
		// 대화는 오래된 화면의 기준 대신 서버의 최신 입력으로 재구성한다.
		body.put("base_version_id", ctx.currentVersionId());
		body.put("current_version_id", ctx.currentVersionId());
		body.put("current_input", repository.findVersion(sessionId, ctx.currentVersion())
				.map(row -> cleanMap(readMap(row.inputJson()))).orElse(null));
		if ("message".equals(request.eventType())) {
			body.put("content", maskPii(request.content()));
		}
		else {
			body.put("question_id", request.questionId());
			body.put("answer", clean(request.answer()));
			body.put("question", prepared.question().get("question"));
		}
		ApiResponse<Map<String, Object>> agent = aiServerClient.post(AGENT_PATH, body, requestKey, MAP_RESPONSE);
		if (agent == null || agent.status() == null || agent.status() == ResponseStatus.ERROR || agent.data() == null) {
			throw new AiServerException("AI 서버가 유효한 해석 결과를 돌려주지 않았습니다: " + AGENT_PATH);
		}
		return transactionTemplate.execute(status -> {
			repository.lockSession(sessionId);
			SessionContextRow latest = ownedContext(sessionId);
			ApiResponse<Map<String, Object>> replay = replay(sessionId, requestKey, fingerprint);
			if (replay != null) {
				return replay;
			}
			if (!Objects.equals(ctx.currentVersionId(), latest.currentVersionId())
					|| ctx.currentVersion() != latest.currentVersion()) {
				throw ApiException.badRequest(STALE_INPUT);
			}
			if (prepared.question() != null) {
				question(latest, request);
			}
			ApiResponse<Map<String, Object>> result = saveAgent(latest, requestKey, fingerprint, request, agent);
			if (prepared.question() != null) {
				repository.markQuestionAnswered(sessionId, request.questionId());
			}
			return result;
		});
	}

	private SessionContextRow ownedContext(long sessionId) {
		return repository.findSessionContext(sessionId).filter(row -> row.ownerKey().equals(currentOwner.key()))
				.orElseThrow(() -> ApiException.notFound(SESSION_NOT_FOUND));
	}

	private void validate(WorkSessionEventRequest request) {
		if (request == null || request.eventType() == null) {
			throw ApiException.badRequest("eventType이 올바르지 않습니다.");
		}
		switch (request.eventType()) {
			case "form" -> {
				if (request.formInput() == null || request.formInput().isEmpty()) {
					throw ApiException.badRequest("form 입력이 필요합니다.");
				}
			}
			case "message" -> {
				if (request.content() == null || request.content().isBlank()) {
					throw ApiException.badRequest("대화 내용이 필요합니다.");
				}
			}
			case "question_reply" -> {
				if (request.questionId() == null || request.questionId().isBlank()
						|| !(request.answer() instanceof Map<?, ?> || request.answer() instanceof String)
						|| request.answer() instanceof String text && text.isBlank()) {
					throw ApiException.badRequest("질문 답변 정보가 필요합니다.");
				}
			}
			default -> throw ApiException.badRequest("eventType이 올바르지 않습니다.");
		}
	}

	private Map<String, Object> question(SessionContextRow ctx, WorkSessionEventRequest request) {
		Map<String, Object> metadata = repository.findQuestionMetadata(ctx.sessionId(), request.questionId())
				.map(this::readMap).orElseThrow(() -> ApiException.badRequest("유효한 서버 질문이 아닙니다."));
		Object base = metadata.get("base_version_id");
		Long baseId = base instanceof Number number ? number.longValue() : null;
		if (Boolean.TRUE.equals(metadata.get("answered")) || !Objects.equals(baseId, ctx.currentVersionId())
				|| request.baseVersionId() != null && !Objects.equals(request.baseVersionId(), baseId)) {
			throw ApiException.badRequest("지난 질문입니다. 최신 입력에서 다시 질문을 받아 주세요.");
		}
		return metadata;
	}

	private ApiResponse<Map<String, Object>> saveAgent(SessionContextRow ctx, String key, String fingerprint,
			WorkSessionEventRequest request, ApiResponse<Map<String, Object>> agent) {
		Map<String, Object> data = cleanMap(agent.data());
		String userContent = "message".equals(request.eventType()) ? maskPii(request.content())
				: writeJson(clean(request.answer()));
		if (agent.status() == ResponseStatus.OK) {
			if ("NO_CHANGE".equals(data.get("detail_status"))) {
				data.put("session_id", ctx.sessionId());
				data.put("input_version_id", ctx.currentVersionId());
				data.put("version_no", ctx.currentVersion());
				data.put("step", ctx.step());
				long userMessageId = idGenerator.next();
				long messageId = idGenerator.next();
				data.put("message_id", messageId);
				ApiResponse<Map<String, Object>> response = new ApiResponse<>(ResponseStatus.OK, data,
						agent.message() == null ? "입력은 바꾸지 않았어요." : maskPii(agent.message()));
				saveMessages(ctx, ctx.currentVersion(), key, fingerprint, request.eventType(), userContent, userMessageId, messageId, response);
				repository.updateSessionProgress(ctx.sessionId(), ctx.currentVersion(), ctx.step());
				return response;
			}
			if (!(data.get("parsed_input") instanceof Map<?, ?> parsed)
					|| !(parsed.get("input") instanceof Map<?, ?> input) || input.isEmpty()) {
				throw new AiServerException("AI 해석 결과에 전체 입력 스냅샷(parsed_input.input)이 없습니다.");
			}
			Map<String, Object> snapshot = cleanMap(input);
			try {
				validateInput(snapshot);
			}
			catch (ApiException e) {
				throw new AiServerException("AI 해석 결과의 입력 스냅샷이 올바르지 않습니다.", e);
			}
			return saveInput(ctx, key, fingerprint, request.eventType(), userContent, snapshot,
					cleanMap(parsed), list(data.get("assumptions")), list(data.get("warnings")));
		}
		return saveResponse(ctx, key, fingerprint, request.eventType(), userContent, agent.status(), data, agent.message());
	}

	private ApiResponse<Map<String, Object>> saveResponse(SessionContextRow ctx, String key, String fingerprint,
			String source, String userContent, ResponseStatus status, Map<String, Object> data, String message) {
		if (status == ResponseStatus.NEEDS_INPUT) {
			if (!(data.get("missing_fields") instanceof List<?> missing) || missing.isEmpty()
					|| missing.stream().anyMatch(field -> !(field instanceof Map<?, ?> map)
							|| !(map.get("path") instanceof String path) || path.isBlank())) {
				throw new AiServerException("AI 질문에 누락 필드 정보가 없습니다.");
			}
			data.put("question_id", "q_" + UUID.randomUUID());
			data.put("base_version_id", ctx.currentVersionId());
			data.put("input_version_id", null);
		}
		data.put("session_id", ctx.sessionId());
		long userMessageId = idGenerator.next();
		long messageId = idGenerator.next();
		data.put("message_id", messageId);
		ApiResponse<Map<String, Object>> response = new ApiResponse<>(status, data, message == null ? "" : maskPii(message));
		saveMessages(ctx, ctx.currentVersion(), key, fingerprint, source, userContent, userMessageId, messageId, response);
		return response;
	}

	private ApiResponse<Map<String, Object>> saveInput(SessionContextRow ctx, String key, String fingerprint,
			String source, String userContent, Map<String, Object> input, Map<String, Object> parsed,
			List<?> assumptions, List<?> warnings) {
		validateInput(input);
		List<Map<String, Object>> unknown = new java.util.ArrayList<>();
		collectUnknown(input, "", unknown);
		if (!unknown.isEmpty()) {
			Map<String, Object> data = new LinkedHashMap<>();
			data.put("draft_input", input);
			data.put("missing_fields", unknown);
			return saveResponse(ctx, key, fingerprint, source, userContent, ResponseStatus.NEEDS_INPUT, data,
					"모르는 값은 확인이 필요해요. 빠진 입력을 알려 주세요.");
		}
		var current = repository.findVersion(ctx.sessionId(), ctx.currentVersion());
		boolean changed = current.isEmpty() || !readMap(current.get().inputJson()).equals(input);
		int versionNo = current.isEmpty() ? Math.max(1, ctx.currentVersion()) : ctx.currentVersion() + (changed ? 1 : 0);
		long versionId = changed ? idGenerator.next() : current.get().inputVersionId();
		if (changed) {
			repository.insertVersion(versionId, ctx.sessionId(), versionNo, ctx.featureType() + ".v1", null,
					writeJson(input), OffsetDateTime.now());
		}
		repository.updateSessionProgress(ctx.sessionId(), versionNo, changed ? "review" : ctx.step());
		long userMessageId = idGenerator.next();
		long messageId = idGenerator.next();
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("session_id", ctx.sessionId());
		data.put("input_version_id", versionId);
		data.put("version_no", versionNo);
		data.put("step", changed ? "review" : ctx.step());
		data.put("message_id", messageId);
		data.put("parsed_input", parsed);
		data.put("assumptions", assumptions);
		data.put("warnings", warnings);
		ApiResponse<Map<String, Object>> response = new ApiResponse<>(ResponseStatus.OK, data,
				changed ? "입력을 저장했어요. 입력을 확인해 주세요." : "바뀐 내용이 없어요. 현재 입력을 유지합니다.");
		saveMessages(ctx, versionNo, key, fingerprint, source, userContent, userMessageId, messageId, response);
		return response;
	}

	private void saveMessages(SessionContextRow ctx, int version, String key, String fingerprint, String source,
			String userContent, long userMessageId, long messageId, ApiResponse<Map<String, Object>> response) {
		Map<String, Object> metadata = new LinkedHashMap<>();
		metadata.put("request_key", key);
		metadata.put("fingerprint", fingerprint);
		metadata.put("source", source);
		metadata.put("response", response);
		if (response.status() == ResponseStatus.NEEDS_INPUT) {
			metadata.put("question_id", response.data().get("question_id"));
			metadata.put("base_version_id", ctx.currentVersionId());
			metadata.put("question", response.data());
		}
		OffsetDateTime now = OffsetDateTime.now();
		repository.insertMessage(userMessageId, ctx.sessionId(), version, "user", userContent, null, now);
		repository.insertMessage(messageId, ctx.sessionId(), version, "assistant", response.message(), writeJson(metadata), now);
		// 질문만 오간 이벤트도 최근 업무 정렬에 반영한다.
		if (response.status() != ResponseStatus.OK) {
			repository.updateSessionProgress(ctx.sessionId(), ctx.currentVersion(), ctx.step());
		}
	}

	private ApiResponse<Map<String, Object>> replay(long sessionId, String key, String fingerprint) {
		return repository.findEventMetadata(sessionId, key).map(this::readMap).map(metadata -> {
			if (!fingerprint.equals(metadata.get("fingerprint"))) {
				throw ApiException.badRequest("같은 요청 키로 다른 입력을 보낼 수 없습니다.");
			}
			return objectMapper.readValue(writeJson(metadata.get("response")), RESPONSE_TYPE);
		}).orElse(null);
	}

	private List<?> list(Object value) {
		return value instanceof List<?> values ? values : List.of();
	}

	/** 확정된 공통 숫자·단위 계약만 검사한다. null은 모르는 값으로 유지하며 0으로 채우지 않는다. */
	private void validateInput(Object value) {
		if (value instanceof List<?> values) {
			values.forEach(this::validateInput);
		}
		else if (value instanceof Map<?, ?> fields) {
			fields.forEach((key, item) -> {
				String name = String.valueOf(key);
				boolean integer = List.of("budget_krw", "planning_days", "max_delivery_count", "minimum_order_krw",
						"delivery_fee_krw", "free_delivery_min_krw", "pack_price_krw").contains(name);
				boolean numeric = integer || List.of("gross_need", "usable_inventory", "safety_stock",
						"storage_capacity", "max_end_inventory", "pack_size").contains(name);
				if (numeric && item != null) {
					if (!(item instanceof Number number)) {
						throw ApiException.badRequest(name + " 값은 숫자여야 합니다.");
					}
					BigDecimal decimal;
					try {
						decimal = new BigDecimal(number.toString());
					}
					catch (NumberFormatException e) {
						throw ApiException.badRequest(name + " 값은 유한한 숫자여야 합니다.");
					}
					boolean positive = List.of("planning_days", "max_delivery_count", "storage_capacity", "pack_size").contains(name);
					if (decimal.signum() < 0 || positive && decimal.signum() == 0
							|| integer && decimal.stripTrailingZeros().scale() > 0) {
						throw ApiException.badRequest(name + " 값의 범위나 단위가 올바르지 않습니다.");
					}
				}
				if (("base_unit".equals(name) || "pack_unit".equals(name)) && item != null
						&& !List.of("g", "ml", "ea").contains(item)) {
					throw ApiException.badRequest(name + " 단위는 g, ml, ea 중 하나여야 합니다.");
				}
				validateInput(item);
			});
			if (fields.get("max_end_inventory") instanceof Number maximum
					&& fields.get("safety_stock") instanceof Number safety
					&& new BigDecimal(maximum.toString()).compareTo(new BigDecimal(safety.toString())) < 0) {
				throw ApiException.badRequest("기간 끝 재고 한도는 안전재고 이상이어야 합니다.");
			}
		}
	}

	private void collectUnknown(Object value, String prefix, List<Map<String, Object>> missing) {
		if (value instanceof Map<?, ?> map) {
			map.forEach((key, item) -> {
				String name = String.valueOf(key);
				String path = prefix.isEmpty() ? name : prefix + "." + name;
				if (item == null && List.of("budget_krw", "planning_days", "max_delivery_count", "gross_need",
						"usable_inventory", "safety_stock").contains(name)) {
					missing.add(Map.of("path", path, "label", name));
				}
				else {
					collectUnknown(item, path, missing);
				}
			});
		}
		else if (value instanceof List<?> values) {
			for (int i = 0; i < values.size(); i++) {
				collectUnknown(values.get(i), prefix + "[" + i + "]", missing);
			}
		}
	}

	private String maskPii(String text) {
		return NAMED_PERSON.matcher(EMAIL.matcher(PHONE.matcher(text).replaceAll("[전화번호]"))
				.replaceAll("[이메일]")).replaceAll("$1[이름]");
	}

	private Object clean(Object value) {
		if (value instanceof String text) {
			return maskPii(text);
		}
		if (value instanceof Map<?, ?> map) {
			Map<String, Object> result = new LinkedHashMap<>();
			map.forEach((key, item) -> {
				String name = String.valueOf(key);
				result.put(name, PRIVATE_FIELDS.contains(name.toLowerCase()) && item != null ? "[개인정보]" : clean(item));
			});
			return result;
		}
		if (value instanceof List<?> list) {
			return list.stream().map(this::clean).toList();
		}
		return value;
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> cleanMap(Map<?, ?> map) {
		return (Map<String, Object>) clean(map);
	}

	private Object canonical(Object value) {
		if (value instanceof Map<?, ?> map) {
			Map<String, Object> result = new TreeMap<>();
			map.forEach((key, item) -> result.put(String.valueOf(key), canonical(item)));
			return result;
		}
		if (value instanceof List<?> values) {
			return values.stream().map(this::canonical).toList();
		}
		return value;
	}

	private String fingerprint(WorkSessionEventRequest request) {
		Map<String, Object> fields = new LinkedHashMap<>();
		fields.put("event_type", request.eventType());
		fields.put("base_version_id", request.baseVersionId());
		fields.put("content", request.content());
		fields.put("form_input", request.formInput());
		fields.put("question_id", request.questionId());
		fields.put("answer", request.answer());
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
					.digest(writeJson(canonical(fields)).getBytes(StandardCharsets.UTF_8)));
		}
		catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	private Map<String, Object> readMap(String json) {
		return objectMapper.readValue(json, MAP_TYPE);
	}

	private String writeJson(Object value) {
		return objectMapper.writeValueAsString(value);
	}
}
