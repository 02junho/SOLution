package com.solution.purchase.controller;

import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.purchase.service.PurchaseService;

@WebMvcTest(PurchaseController.class)
class PurchaseControllerTest {

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private PurchaseService purchaseService;

	@Test
	void 계산_실행은_snake_case_본문과_요청키를_받는다() throws Exception {
		given(purchaseService.run(100, 1001, "key-1"))
				.willReturn(ApiResponse.ok(Map.of("result_id", 2001, "detail_status", "OPTIMAL")));

		mockMvc.perform(post("/api/v1/purchase/sessions/100/results")
				.contentType(MediaType.APPLICATION_JSON)
				.header("X-Request-Key", "key-1")
				.content("{\"input_version_id\": 1001}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.result_id").value(2001));
	}

	@Test
	void 입력_버전이_없으면_400() throws Exception {
		mockMvc.perform(post("/api/v1/purchase/sessions/100/results")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 업무를_못_찾으면_404_공통_오류() throws Exception {
		given(purchaseService.run(100, 1001, null)).willThrow(ApiException.notFound("매입 업무를 찾을 수 없습니다."));

		mockMvc.perform(post("/api/v1/purchase/sessions/100/results")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"input_version_id\": 1001}"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"))
				.andExpect(jsonPath("$.message").value("매입 업무를 찾을 수 없습니다."));
	}

	@Test
	void 옛_조건이면_400_공통_오류() throws Exception {
		given(purchaseService.run(100, 1001, null))
				.willThrow(ApiException.badRequest("조건이 바뀌었어요. 최신 조건으로 다시 계산해 주세요."));

		mockMvc.perform(post("/api/v1/purchase/sessions/100/results")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"input_version_id\": 1001}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.message").value("조건이 바뀌었어요. 최신 조건으로 다시 계산해 주세요."));
	}

	@Test
	void 상세_조회() throws Exception {
		given(purchaseService.detail(2001))
				.willReturn(ApiResponse.ok(Map.of("result_id", 2001, "is_latest_version", true)));

		mockMvc.perform(get("/api/v1/purchase/results/2001"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.is_latest_version").value(true));
	}
}
