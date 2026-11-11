package com.solution.common.system;

import java.util.LinkedHashMap;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;

/**
 * 연결 확인용. 화면 → Spring → (DB, FastAPI → DB)가 모두 이어졌는지 한 번에 본다.
 * Spring → FastAPI 호출 예시이기도 하다.
 */
@RestController
@RequestMapping("/api/v1/system")
public class SystemController {

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> MAP_RESPONSE =
			new ParameterizedTypeReference<>() {
			};

	private final AiServerClient aiServerClient;
	private final JdbcTemplate jdbcTemplate;

	public SystemController(AiServerClient aiServerClient, JdbcTemplate jdbcTemplate) {
		this.aiServerClient = aiServerClient;
		this.jdbcTemplate = jdbcTemplate;
	}

	@GetMapping("/health")
	public ApiResponse<Map<String, Object>> health() {
		Map<String, Object> result = new LinkedHashMap<>();
		result.put("backend", "ok");
		result.put("database", checkDatabase());
		result.put("ai_server", checkAiServer());
		return ApiResponse.ok(result);
	}

	private String checkDatabase() {
		try {
			jdbcTemplate.queryForObject("SELECT 1", Integer.class);
			return "ok";
		}
		catch (DataAccessException e) {
			return "unavailable";
		}
	}

	private Object checkAiServer() {
		try {
			ApiResponse<Map<String, Object>> response = aiServerClient.get("/health", MAP_RESPONSE);
			return response.data();
		}
		catch (AiServerException e) {
			return "unavailable";
		}
	}
}
