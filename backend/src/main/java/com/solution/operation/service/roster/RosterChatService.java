package com.solution.operation.service.roster;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;

/**
 * 추천 근무표의 말로 고치기·결과 설명을 ai-server로 넘긴다(운영 2번, 저장 없음).
 * 바꿀 칸 목록·지금 값·결과 요약은 화면이 보내고, AI가 고른 값의 범위 검사는 ai-server가 칸 정의로 한다.
 * 직원 이름 대신 별칭(P1, P2…)만 오간다. 여기서는 크기만 막는다.
 */
@Service
public class RosterChatService {

	static final int MAX_MESSAGE = 300;
	static final int MAX_FIELDS = 30;
	static final int MAX_WORKERS = 20;

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };

	private final AiServerClient client;

	public RosterChatService(AiServerClient client) {
		this.client = client;
	}

	/** 요청: {"message", "fields", "state", "workers", "result"(선택)} */
	public ApiResponse<Map<String, Object>> chat(Map<String, Object> body) {
		if (!(body.get("message") instanceof String message) || message.isBlank() || message.length() > MAX_MESSAGE) {
			throw ApiException.badRequest("INVALID_REQUEST", "말은 1~" + MAX_MESSAGE + "자로 보내 주세요.");
		}
		if (!(body.get("fields") instanceof List<?> fields) || fields.isEmpty() || fields.size() > MAX_FIELDS) {
			throw ApiException.badRequest("INVALID_REQUEST", "바꿀 수 있는 칸 목록(fields)을 보내 주세요.");
		}
		if (body.get("workers") instanceof List<?> workers && workers.size() > MAX_WORKERS) {
			throw ApiException.badRequest("INVALID_REQUEST", "직원은 " + MAX_WORKERS + "명까지예요.");
		}
		Map<String, Object> request = new LinkedHashMap<>();
		for (String key : List.of("message", "fields", "state", "workers", "result")) {
			if (body.get(key) != null) {
				request.put(key, body.get(key));
			}
		}
		return call("/tools/simulation/roster-chat", request, ":roster-chat", "말로 고치기 응답을 받지 못했습니다.");
	}

	/** 요청: {"result": 결과 요약, "fallback": 코드가 만든 요약 문장} */
	public ApiResponse<Map<String, Object>> explain(Map<String, Object> body) {
		if (!(body.get("result") instanceof Map<?, ?> result) || result.isEmpty()) {
			throw ApiException.badRequest("INVALID_REQUEST", "결과 요약(result)을 보내 주세요.");
		}
		if (!(body.get("fallback") instanceof String fallback) || fallback.isBlank() || fallback.length() > 500) {
			throw ApiException.badRequest("INVALID_REQUEST", "기본 요약 문장(fallback)을 보내 주세요.");
		}
		return call("/tools/simulation/roster-explain", Map.of("result", result, "fallback", fallback), ":roster-explain",
				"결과 설명 응답을 받지 못했습니다.");
	}

	private ApiResponse<Map<String, Object>> call(String path, Map<String, Object> request, String suffix, String failure) {
		String key = AiServerClient.newRequestKey() + suffix;
		ApiResponse<Map<String, Object>> response = client.post(path, request, key, RESPONSE);
		if (response == null || response.status() == null || response.status() == ResponseStatus.ERROR) {
			throw new AiServerException(failure);
		}
		return response;
	}
}
