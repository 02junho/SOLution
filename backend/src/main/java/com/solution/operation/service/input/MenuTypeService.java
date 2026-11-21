package com.solution.operation.service.input;

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
 * 가게 파일의 메뉴 이름 중 낱말 규칙으로 모른 것만 받아 ai-server /tools/simulation/menu-types로 넘긴다.
 * 메뉴 이름과 유형 목록만 오가고 원본 줄·금액은 보내지 않는다. 저장하지 않는다(DB 변경 없음).
 */
@Service
public class MenuTypeService {

	static final int MAX_NAMES = 40;
	static final int MAX_NAME_LENGTH = 40;
	static final int MAX_TYPES = 20;

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };

	private final AiServerClient client;

	public MenuTypeService(AiServerClient client) {
		this.client = client;
	}

	public ApiResponse<Map<String, Object>> classify(Map<String, Object> body) {
		if (!(body.get("names") instanceof List<?> names) || names.isEmpty() || names.size() > MAX_NAMES
				|| names.stream().anyMatch(n -> !(n instanceof String s) || s.isBlank() || s.length() > MAX_NAME_LENGTH)) {
			throw ApiException.badRequest("INVALID_REQUEST", "메뉴 이름을 1~" + MAX_NAMES + "개, 각 " + MAX_NAME_LENGTH + "자 이내로 보내 주세요.");
		}
		if (!(body.get("types") instanceof List<?> types) || types.isEmpty() || types.size() > MAX_TYPES) {
			throw ApiException.badRequest("INVALID_REQUEST", "유형 목록(types)을 보내 주세요.");
		}
		Map<String, Object> request = new LinkedHashMap<>();
		request.put("names", names);
		request.put("types", types);
		String key = AiServerClient.newRequestKey() + ":menu-types";
		ApiResponse<Map<String, Object>> response = client.post("/tools/simulation/menu-types", request, key, RESPONSE);
		if (response == null || response.status() == null || response.status() == ResponseStatus.ERROR) {
			throw new AiServerException("메뉴 유형 응답을 받지 못했습니다.");
		}
		return response;
	}
}
