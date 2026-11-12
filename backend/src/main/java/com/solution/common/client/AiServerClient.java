package com.solution.common.client;

import java.util.UUID;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;

import com.solution.common.response.ApiResponse;

/**
 * Spring → FastAPI 호출은 이 클래스로만 한다.
 *
 * <ul>
 *   <li>주소: FastAPI의 도구는 /tools/{기능}, 에이전트는 /agent/interpret(해석)·/agent/explain(설명)
 *       (예: post("/tools/labor", ...))</li>
 *   <li>요청 키: X-Request-Key 헤더로 넘긴다. FastAPI는 이 키로 execution_log를 남긴다.</li>
 *   <li>응답: FastAPI도 { status, data, message } 형식으로 돌려준다.
 *       ok·needs_input·infeasible은 그대로 반환하고, 연결 실패·HTTP 오류는 AiServerException으로 던진다.</li>
 * </ul>
 */
@Component
public class AiServerClient {

	public static final String REQUEST_KEY_HEADER = "X-Request-Key";

	private final RestClient restClient;

	public AiServerClient(RestClient aiServerRestClient) {
		this.restClient = aiServerRestClient;
	}

	public <T> ApiResponse<T> get(String path, ParameterizedTypeReference<ApiResponse<T>> type) {
		return get(path, newRequestKey(), type);
	}

	public <T> ApiResponse<T> get(String path, String requestKey,
			ParameterizedTypeReference<ApiResponse<T>> type) {
		try {
			return restClient.get()
					.uri(path)
					.header(REQUEST_KEY_HEADER, requestKey)
					.retrieve()
					.body(type);
		}
		catch (RestClientResponseException e) {
			throw new AiServerException("AI 서버 오류 (HTTP " + e.getStatusCode().value() + "): " + path, e);
		}
		catch (RestClientException e) {
			throw new AiServerException("AI 서버에 연결하지 못했습니다: " + path, e);
		}
	}

	public <T> ApiResponse<T> post(String path, Object body, String requestKey,
			ParameterizedTypeReference<ApiResponse<T>> type) {
		try {
			return restClient.post()
					.uri(path)
					.contentType(MediaType.APPLICATION_JSON)
					.header(REQUEST_KEY_HEADER, requestKey)
					.body(body)
					.retrieve()
					.body(type);
		}
		catch (RestClientResponseException e) {
			throw new AiServerException("AI 서버 오류 (HTTP " + e.getStatusCode().value() + "): " + path, e);
		}
		catch (RestClientException e) {
			throw new AiServerException("AI 서버에 연결하지 못했습니다: " + path, e);
		}
	}

	/** 같은 요청을 다시 보낼 때는 처음 만든 키를 그대로 써야 중복 저장을 막을 수 있다. */
	public static String newRequestKey() {
		return UUID.randomUUID().toString();
	}
}
