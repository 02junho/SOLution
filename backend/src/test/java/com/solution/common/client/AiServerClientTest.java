package com.solution.common.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withServerError;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;

class AiServerClientTest {

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> MAP_RESPONSE =
			new ParameterizedTypeReference<>() {
			};

	private MockRestServiceServer server;
	private AiServerClient client;

	@BeforeEach
	void setUp() {
		RestClient.Builder builder = RestClient.builder().baseUrl("http://ai-server");
		server = MockRestServiceServer.bindTo(builder).build();
		client = new AiServerClient(builder.build());
	}

	@Test
	void 요청키를_헤더로_보내고_공통_응답을_읽는다() {
		server.expect(requestTo("http://ai-server/tools/labor"))
				.andExpect(method(HttpMethod.POST))
				.andExpect(header(AiServerClient.REQUEST_KEY_HEADER, "key-1"))
				.andExpect(content().json("{\"hours\": 2}"))
				.andRespond(withSuccess("""
						{"status": "needs_input", "data": {"missing_fields": ["wage_krw"]}, "message": "시급을 알려주세요"}
						""", MediaType.APPLICATION_JSON));

		ApiResponse<Map<String, Object>> response = client.post("/tools/labor", Map.of("hours", 2), "key-1", MAP_RESPONSE);

		assertThat(response.status()).isEqualTo(ResponseStatus.NEEDS_INPUT);
		assertThat(response.data()).containsKey("missing_fields");
		assertThat(response.message()).isEqualTo("시급을 알려주세요");
		server.verify();
	}

	@Test
	void AI_서버가_500을_주면_AiServerException() {
		server.expect(requestTo("http://ai-server/health")).andRespond(withServerError());

		assertThatThrownBy(() -> client.get("/health", MAP_RESPONSE))
				.isInstanceOf(AiServerException.class)
				.hasMessageContaining("HTTP 500");
	}
}
