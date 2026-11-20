package com.solution.explain;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

/**
 * 결과 화면의 "AI 결과 설명": 저장된 결과를 쉬운 말로 풀어 달라고 FastAPI /agent/explain(혜원, HW-F08)에 요청한다.
 * 작성: 신준호
 *
 * <p>흐름: 화면 → Spring(권한·결과 확인, 작은 요약 추리기) → FastAPI /agent/explain → 화면.
 * 설명은 저장하지 않고, 계산을 다시 돌리지 않는다. 결과의 숫자·추천·경고는 바꾸지 않는다.
 * 권한은 결과의 복제 필드가 아니라 실제 결과→버전→업무→매장 경로로 확인하고, 지운 업무의 결과는 없는 것으로 본다.
 */
@Service
public class ResultExplanationService {

	static final String PATH = "/agent/explain";
	private static final String NOT_FOUND = "결과를 찾을 수 없어요.";
	private static final TypeReference<LinkedHashMap<String, Object>> JSON_MAP = new TypeReference<>() { };
	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };

	record Source(long resultId, long sessionId, long storeId, String featureType, String ownerKey,
			String responseStatus, String summaryJson) {
	}

	private final JdbcTemplate jdbc;
	private final AiServerClient client;
	private final CurrentOwner owner;
	private final ObjectMapper mapper;

	public ResultExplanationService(JdbcTemplate jdbc, AiServerClient client, CurrentOwner owner, ObjectMapper mapper) {
		this.jdbc = jdbc;
		this.client = client;
		this.owner = owner;
		this.mapper = mapper;
	}

	public ApiResponse<Map<String, Object>> explain(long resultId, String suppliedKey) {
		Source source = find(resultId).filter(row -> row.ownerKey().equals(owner.key()))
				.orElseThrow(() -> ApiException.notFound("RESULT_NOT_FOUND", NOT_FOUND));
		if (!"ok".equals(source.responseStatus())) {
			throw ApiException.badRequest("RESULT_NOT_EXPLAINABLE", "계산이 끝난 결과만 설명할 수 있어요.");
		}
		Map<String, Object> stored = source.summaryJson() == null ? Map.of()
				: mapper.readValue(source.summaryJson(), JSON_MAP);
		Map<String, Object> summary = "operation".equals(source.featureType())
				? ExplanationSummary.operation(stored) : ExplanationSummary.purchase(stored);
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("store_id", source.storeId());
		body.put("session_id", source.sessionId());
		body.put("feature_type", source.featureType());
		body.put("result_id", source.resultId());
		body.put("result_summary", summary);
		String key = suppliedKey == null || suppliedKey.isBlank() ? AiServerClient.newRequestKey() : suppliedKey;
		ApiResponse<Map<String, Object>> response = client.post(PATH, body, key, RESPONSE);
		if (response == null || response.status() != ResponseStatus.OK || response.data() == null
				|| !(response.data().get("explanation") instanceof Map<?, ?>)) {
			throw new AiServerException("결과 설명을 받지 못했어요.");
		}
		// 숫자 값은 그대로 두고 쉼표·말투·운영 첫 줄·겹치는 주의만 다듬는다(ExplanationText).
		Map<String, Object> polished = ExplanationText.polish(response.data(), source.featureType(), summary);
		Object headline = polished.get("explanation") instanceof Map<?, ?> e ? e.get("headline") : null;
		return new ApiResponse<>(response.status(), polished,
				headline instanceof String text ? text : response.message());
	}

	Optional<Source> find(long resultId) {
		return jdbc.query("""
				SELECT r.result_id, s.session_id, s.store_id, s.feature_type, st.owner_key,
				       r.response_status, r.summary_json::text AS summary_json
				FROM work_result r
				JOIN work_version v ON v.input_version_id = r.input_version_id
				JOIN work_session s ON s.session_id = v.session_id AND s.deleted_at IS NULL
				JOIN store st ON st.store_id = s.store_id
				WHERE r.result_id = ?
				""", (rs, i) -> new Source(rs.getLong("result_id"), rs.getLong("session_id"), rs.getLong("store_id"),
				rs.getString("feature_type"), rs.getString("owner_key"), rs.getString("response_status"),
				rs.getString("summary_json")), resultId).stream().findFirst();
	}
}
