package com.solution.operation.controller;

import static org.mockito.ArgumentMatchers.*;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.operation.service.OperationResultService;

@WebMvcTest(OperationResultController.class)
class OperationResultControllerTest {

	@Autowired private MockMvc mvc;
	@MockitoBean private OperationResultService service;

	@Test
	void acceptsOnlyVersionIdAndIdempotencyKey() throws Exception {
		given(service.run(520001, 530001, "same-key")).willReturn(ApiResponse.ok(Map.of("result_id", 7001)));
		mvc.perform(post("/api/v1/operation/sessions/520001/results").contentType(MediaType.APPLICATION_JSON)
				.header("Idempotency-Key", "same-key").content("{\"input_version_id\":530001}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.result_id").value(7001));
	}

	@Test
	void Idempotency_Key가_없으면_서버가_만들지_않고_서비스가_400으로_막는다() throws Exception {
		given(service.run(520001, 530001, null))
				.willThrow(ApiException.badRequest("INVALID_REQUEST", "Idempotency-Key는 1~100자의 요청 키여야 합니다."));
		mvc.perform(post("/api/v1/operation/sessions/520001/results").contentType(MediaType.APPLICATION_JSON)
				.content("{\"input_version_id\":530001}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("INVALID_REQUEST"));
	}

	@Test
	void requiresVersionId() throws Exception {
		mvc.perform(post("/api/v1/operation/sessions/520001/results").contentType(MediaType.APPLICATION_JSON).content("{}"))
				.andExpect(status().isBadRequest()).andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void returnsNotFoundWithoutForbidden() throws Exception {
		given(service.result(7001, "summary")).willThrow(ApiException.notFound("RESULT_NOT_FOUND", "운영 결과를 찾을 수 없습니다."));
		mvc.perform(get("/api/v1/operation/results/7001")).andExpect(status().isNotFound())
				.andExpect(jsonPath("$.data.detail_code").value("RESULT_NOT_FOUND"));
	}

	@Test
	void rejectsUnconfirmedInputWithoutConflict() throws Exception {
		given(service.run(eq(520001L), eq(530001L), anyString()))
				.willThrow(ApiException.badRequest("INPUT_NOT_CONFIRMED", "입력을 먼저 확인해 주세요."));
		mvc.perform(post("/api/v1/operation/sessions/520001/results").contentType(MediaType.APPLICATION_JSON)
				.header("Idempotency-Key", "key-1").content("{\"input_version_id\":530001}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("INPUT_NOT_CONFIRMED"))
				.andExpect(jsonPath("$.message").value("입력을 먼저 확인해 주세요."));
	}

	@Test
	void returnsBadGatewayForEngineFailure() throws Exception {
		given(service.run(eq(520001L), eq(530001L), anyString())).willThrow(new AiServerException("계산을 완료하지 못했습니다."));
		mvc.perform(post("/api/v1/operation/sessions/520001/results").contentType(MediaType.APPLICATION_JSON)
				.header("Idempotency-Key", "key-1").content("{\"input_version_id\":530001}"))
				.andExpect(status().isBadGateway()).andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void routesDetailAndTraceToReadsOnly() throws Exception {
		given(service.result(7001, "detail")).willReturn(ApiResponse.ok(Map.of("result_id", 7001)));
		given(service.trace(7001, 9001)).willReturn(ApiResponse.ok(Map.of("log_id", 9001)));
		mvc.perform(get("/api/v1/operation/results/7001?view=detail")).andExpect(status().isOk());
		mvc.perform(get("/api/v1/operation/results/7001/traces/9001")).andExpect(status().isOk()).andExpect(jsonPath("$.data.log_id").value(9001));
	}
}
