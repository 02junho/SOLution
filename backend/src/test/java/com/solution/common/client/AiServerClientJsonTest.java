package com.solution.common.client;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.restclient.test.autoconfigure.RestClientTest;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;

import com.solution.common.response.ApiResponse;

/** Spring → FastAPI 요청·응답도 snake_case인지 확인 (Spring Boot가 만든 RestClient.Builder 사용) */
@RestClientTest
class AiServerClientJsonTest {

	@Autowired
	private RestClient.Builder builder;

	record LaborRequest(int hoursPerDay, long wageKrw) {
	}

	record LaborResult(long monthlyCostKrw) {
	}

	@Test
	void 보내는_본문과_받는_본문_모두_snake_case() {
		builder.baseUrl("http://ai-server");
		MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
		AiServerClient client = new AiServerClient(builder.build());

		server.expect(requestTo("http://ai-server/tools/labor"))
				.andExpect(content().json("{\"hours_per_day\": 2, \"wage_krw\": 10320}", true))
				.andRespond(withSuccess("{\"status\": \"ok\", \"data\": {\"monthly_cost_krw\": 450000}}",
						MediaType.APPLICATION_JSON));

		ApiResponse<LaborResult> response = client.post("/tools/labor", new LaborRequest(2, 10320), "key-1",
				new ParameterizedTypeReference<>() {
				});

		assertThat(response.data().monthlyCostKrw()).isEqualTo(450000);
		server.verify();
	}
}
