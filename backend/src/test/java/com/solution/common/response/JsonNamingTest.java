package com.solution.common.response;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** Java 필드는 camelCase, API JSON은 snake_case로 주고받는지 확인 (Code Convention) */
@WebMvcTest(JsonNamingTest.EchoController.class)
@Import(JsonNamingTest.EchoController.class)
class JsonNamingTest {

	@Autowired
	private MockMvc mockMvc;

	record PurchaseItem(String itemId, int requiredG, Long priceKrw) {
	}

	@RestController
	static class EchoController {

		@PostMapping("/api/v1/test/echo")
		ApiResponse<PurchaseItem> echo(@RequestBody PurchaseItem item) {
			return ApiResponse.needsInput(item, "시급을 알려주세요");
		}
	}

	@Test
	void 요청과_응답_모두_snake_case() throws Exception {
		mockMvc.perform(post("/api/v1/test/echo")
						.contentType(MediaType.APPLICATION_JSON)
						.content("{\"item_id\": \"milk_1l\", \"required_g\": 2700, \"price_krw\": 31900}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("needs_input"))
				.andExpect(jsonPath("$.data.item_id").value("milk_1l"))
				.andExpect(jsonPath("$.data.required_g").value(2700))
				.andExpect(jsonPath("$.data.price_krw").value(31900));
	}
}
