package com.solution.session.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;

import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.ConfirmResultRequest;
import com.solution.session.dto.ConfirmResultResponse;
import com.solution.session.service.ConfirmationRepository.Source;
import com.solution.session.service.ConfirmationRepository.Stored;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

@Service
public class WorkResultConfirmService {

	private static final TypeReference<LinkedHashMap<String, Object>> MAP = new TypeReference<>() {};
	private final ConfirmationRepository repository;
	private final SessionRepository sessions;
	private final CurrentOwner owner;
	private final IdGenerator ids;
	private final RequestKeyLock keyLock;
	private final ObjectMapper json;
	private final TransactionTemplate transactions;
	private final ConfirmationAudit audit;

	public WorkResultConfirmService(ConfirmationRepository repository, SessionRepository sessions, CurrentOwner owner,
			IdGenerator ids, RequestKeyLock keyLock, ObjectMapper json, TransactionTemplate transactions, ConfirmationAudit audit) {
		this.repository = repository;
		this.sessions = sessions;
		this.owner = owner;
		this.ids = ids;
		this.keyLock = keyLock;
		this.json = json;
		this.transactions = transactions;
		this.audit = audit;
	}

	public ApiResponse<ConfirmResultResponse> confirm(long resultId, String key, ConfirmResultRequest request) {
		String actor = owner.key();
		Source initial = null;
		long started = System.nanoTime();
		try {
			initial = owned(resultId, actor);
			ApiResponse<ConfirmResultResponse> result = confirmOwned(initial, actor, key, request);
			audit.record(initial, "success", result.data().isNew() ? "CONFIRMED" : "REPLAYED", started);
			return result;
		}
		catch (ResultConfirmException e) {
			audit.record(initial, "refused", e.getDetailCode(), started);
			throw e;
		}
		catch (RuntimeException e) {
			audit.record(initial, "failed", "INTERNAL_ERROR", started);
			throw e;
		}
	}

	private ApiResponse<ConfirmResultResponse> confirmOwned(Source initial, String actor, String key,
			ConfirmResultRequest request) {
		long resultId = initial.resultId();
		if (key == null || key.isBlank() || key.length() > 100) {
			throw error("INVALID_REQUEST", "Idempotency-Key는 1~100자의 요청 키여야 합니다.");
		}
		List<String> acknowledged = normalize(request.acknowledgedWarningIds());
		String fingerprint = fingerprint(actor, resultId, request, acknowledged);
		return transactions.execute(tx -> {
			sessions.lockSession(initial.sessionId());
			Source source = owned(resultId, actor);
			// 요청 키 UQ는 세션 전체가 아니라 전역이다. 서로 다른 세션의 같은 키도 직렬화한다.
			keyLock.lock("confirmation", 0, key);
			var replay = repository.findByKey(key);
			if (replay.isPresent()) {
				if (!fingerprint.equals(replay.get().fingerprint())) {
					throw error("IDEMPOTENCY_KEY_REUSED", "같은 요청 키를 다른 확정 내용에 사용할 수 없습니다.");
				}
				return response(replay.get(), source, false);
			}
			if (source.inputVersionId() != request.expectedInputVersionId()
					|| source.versionNo() != source.currentVersion()) {
				throw error("STALE_RESULT", "조건이 바뀌었어요. 최신 결과를 다시 확인해 주세요.");
			}
			if (source.inputConfirmedAt() == null) {
				throw error("INPUT_NOT_CONFIRMED", "입력을 먼저 확인해 주세요.");
			}
			if (!"ok".equals(source.responseStatus())) {
				throw error("RESULT_NOT_READY", "계산이 완료된 결과만 확정할 수 있습니다.");
			}
			if ("operation".equals(source.featureType())
					&& !Boolean.TRUE.equals(json.readValue(source.summaryJson(), MAP).get("complete"))) {
				throw error("RESULT_NOT_READY", "운영 시뮬레이션 30회 집계가 완료된 결과만 확정할 수 있습니다.");
			}
			Map<String, Object> snapshot = snapshot(source, request.selectedChoiceKey(), acknowledged);
			if (repository.hasVersionConfirmation(source.inputVersionId())) {
				throw error("VERSION_ALREADY_CONFIRMED", "이미 확정한 입력 버전입니다.");
			}
			if (!repository.insert(ids.next(), source, request.selectedChoiceKey(), actor, key, fingerprint,
					json.writeValueAsString(acknowledged), serializeSnapshot(snapshot))) {
				// 외부 쓰기와 UNIQUE가 경합해도 트랜잭션을 깨뜨리지 않고 실제 충돌 종류를 구분한다.
				var existing = repository.findByKey(key);
				if (existing.isPresent()) {
					if (!fingerprint.equals(existing.get().fingerprint())) {
						throw error("IDEMPOTENCY_KEY_REUSED", "같은 요청 키를 다른 확정 내용에 사용할 수 없습니다.");
					}
					return response(existing.get(), source, false);
				}
				if (repository.hasVersionConfirmation(source.inputVersionId())) {
					throw error("VERSION_ALREADY_CONFIRMED", "이미 확정한 입력 버전입니다.");
				}
				throw new IllegalStateException("확정 식별자 충돌");
			}
			sessions.updateSessionProgress(source.sessionId(), source.currentVersion(), "saved");
			return response(repository.findByKey(key).orElseThrow(), source, true);
		});
	}

	private Source owned(long resultId, String actor) {
		return repository.findSource(resultId).filter(row -> actor.equals(row.ownerKey()))
				.orElseThrow(ResultConfirmException::notFound);
	}

	private ApiResponse<ConfirmResultResponse> response(Stored stored, Source source, boolean isNew) {
		return new ApiResponse<>(ResponseStatus.OK, new ConfirmResultResponse(stored.confirmationId(), stored.resultId(),
				stored.inputVersionId(), stored.sessionId(), stored.storeId(), stored.versionNo(), stored.featureType(),
				stored.selectedChoiceKey(), stored.confirmedBy(), stored.confirmedAt(), isNew,
				stored.versionNo() == source.currentVersion(), isNew ? "saved" : source.step()),
				"operation".equals(stored.featureType()) ? "운영안을 저장했어요." : "구매안을 저장했어요.");
	}

	private String serializeSnapshot(Map<String, Object> snapshot) {
		// JSON 문자열 전체를 치환하면 금액 등 숫자 리터럴을 훼손할 수 있어 키·문자열 값만 가린다.
		Object masked = SessionPrivacy.maskSnapshot(snapshot);
		String encoded = json.writeValueAsString(masked);
		Object decoded = json.readValue(encoded, Object.class);
		if (!decoded.equals(SessionPrivacy.maskSnapshot(decoded))) {
			throw notReady();
		}
		return encoded;
	}

	/** 고정 필드 순서의 compact UTF-8 JSON. 경고 ID는 중복 제거 후 오름차순으로 정렬한다. */
	String fingerprint(String actor, long resultId, ConfirmResultRequest request, List<String> acknowledged) {
		Map<String, Object> canonical = new LinkedHashMap<>();
		canonical.put("fingerprint_version", 1);
		canonical.put("actor", actor);
		canonical.put("result_id", resultId);
		canonical.put("expected_input_version_id", request.expectedInputVersionId());
		canonical.put("selected_choice_key", request.selectedChoiceKey());
		canonical.put("acknowledged_warning_ids", acknowledged);
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
					.digest(json.writeValueAsString(canonical).getBytes(StandardCharsets.UTF_8)));
		}
		catch (NoSuchAlgorithmException e) {
			throw new IllegalStateException(e);
		}
	}

	static List<String> normalize(List<String> values) {
		return values == null ? List.of() : List.copyOf(new TreeSet<>(values));
	}

	private Map<String, Object> snapshot(Source source, String selectedKey, List<String> acknowledged) {
		Map<String, Object> summary = json.readValue(source.summaryJson(), MAP);
		Map<String, Map<String, Object>> choices = new LinkedHashMap<>();
		for (Object item : list(summary.get("choices"))) {
			Map<String, Object> choice = map(item);
			String key = text(choice.get("choice_key"));
			if (choices.put(key, choice) != null) {
				throw notReady();
			}
		}
		Map<String, Object> selected = choices.get(selectedKey);
		if (selected == null) {
			throw invalidChoice();
		}
		Map<String, Object> resolved = selected;
		TreeSet<String> visited = new TreeSet<>();
		while (true) {
			if (Boolean.FALSE.equals(resolved.get("available")) || Boolean.FALSE.equals(resolved.get("confirmable"))) {
				throw invalidChoice();
			}
			if (!visited.add(text(resolved.get("choice_key")))) {
				throw notReady();
			}
			if (resolved.get("same_as") == null) {
				break;
			}
			resolved = choices.get(text(resolved.get("same_as")));
			if (resolved == null) {
				throw notReady();
			}
		}
		String resolvedKey = text(resolved.get("choice_key"));
		List<Map<String, Object>> applicable = new ArrayList<>();
		TreeSet<String> known = new TreeSet<>();
		for (Object item : list(summary.get("warnings"))) {
			Map<String, Object> warning = map(item);
			String id = text(warning.get("warning_id"));
			if (!(warning.get("requires_ack") instanceof Boolean) || !known.add(id)) {
				throw notReady();
			}
			List<?> keys = warning.get("choice_keys") == null ? null : list(warning.get("choice_keys"));
			if (keys == null || keys.contains(selectedKey) || keys.contains(resolvedKey)) {
				applicable.add(warning);
				if (Boolean.TRUE.equals(warning.get("requires_ack")) && !acknowledged.contains(id)) {
					throw error("WARNINGS_NOT_ACKNOWLEDGED", "선택한 안의 필수 경고를 먼저 확인해 주세요.");
				}
			}
		}
		if ("operation".equals(source.featureType()) && applicable.stream().noneMatch(warning ->
				"SIMULATED_CONDITIONS".equals(warning.get("warning_id")) && Boolean.TRUE.equals(warning.get("requires_ack")))) {
			throw notReady();
		}

		if (!known.containsAll(acknowledged)) {
			throw error("INVALID_REQUEST", "결과에 없는 경고 ID가 포함되어 있습니다.");
		}
		if (resolved.get("warning_ids") != null && !known.containsAll(list(resolved.get("warning_ids")))) {
			throw notReady();
		}
		Map<String, Object> chosen = new LinkedHashMap<>(resolved);
		chosen.putAll(selected);
		Map<String, Object> snapshot = new LinkedHashMap<>();
		snapshot.put("choice", chosen);
		Object detail = null;
		if (source.detailJson() != null) {
			Map<String, Object> details = json.readValue(source.detailJson(), MAP);
			if (details.get("choices") != null) {
				for (Object item : list(details.get("choices"))) {
					Map<String, Object> value = map(item);
					if (resolvedKey.equals(value.get("choice_key"))) {
						if (detail != null) { throw notReady(); }
						detail = value;
					}
				}
			}
		}
		if ("purchase".equals(source.featureType()) && detail instanceof Map<?, ?> raw
				&& raw.get("lines") instanceof List<?> lines) {
			// 결과가 가리키는 불변 입력 버전에서 이름을 복사한다. 현재 화면 입력은 사용하지 않는다.
			Map<String, Object> input = sessions.findVersion(source.sessionId(), source.versionNo())
					.map(version -> json.readValue(version.inputJson(), MAP)).orElseGet(LinkedHashMap::new);
			Map<String, Object> preserved = new LinkedHashMap<>(map(detail));
			preserved.put("lines", lines.stream().map(line -> {
				if (!(line instanceof Map<?, ?>)) { return line; }
				Map<String, Object> copy = new LinkedHashMap<>(map(line));
				copyName(copy, input.get("items"), "item_id", "item_name");
				copyName(copy, input.get("suppliers"), "supplier_id", "supplier_name");
				return copy;
			}).toList());
			detail = preserved;
		}
		snapshot.put("detail", detail);
		snapshot.put("warnings", applicable);
		snapshot.put("assumptions", summary.getOrDefault("assumptions", List.of()));
		return snapshot;
	}

	private void copyName(Map<String, Object> line, Object entries, String id, String name) {
		if (line.get(id) == null || !(entries instanceof List<?> values)) { return; }
		for (Object entry : values) {
			if (entry instanceof Map<?, ?> value && java.util.Objects.equals(line.get(id), value.get(id))
					&& value.get(name) instanceof String text && !text.isBlank()) {
				line.put(name, text);
				return;
			}
		}
	}

	private List<?> list(Object value) {
		if (!(value instanceof List<?> result)) { throw notReady(); }
		return result;
	}

	@SuppressWarnings("unchecked")
	private Map<String, Object> map(Object value) {
		if (!(value instanceof Map<?, ?> result)) { throw notReady(); }
		return (Map<String, Object>) result;
	}

	private String text(Object value) {
		if (!(value instanceof String result) || result.isBlank()) { throw notReady(); }
		return result;
	}

	private ResultConfirmException invalidChoice() {
		return error("INVALID_CHOICE", "이 결과에서 선택할 수 있는 안이 아닙니다.");
	}

	private ResultConfirmException notReady() {
		return error("RESULT_NOT_READY", "결과의 선택안·경고 정보를 확인할 수 없습니다.");
	}

	private ResultConfirmException error(String code, String message) {
		return new ResultConfirmException(code, message);
	}
}
