package com.solution.session.controller;

import static org.mockito.BDDMockito.given;
import static org.mockito.ArgumentMatchers.any;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkSessionResponse;
import com.solution.session.service.WorkSessionService;

@WebMvcTest(WorkSessionController.class)
class WorkSessionControllerTest {

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private WorkSessionService workSessionService;

	@Test
	void 업무_시작은_snake_case_본문을_받아_세션을_돌려준다() throws Exception {
		given(workSessionService.create(any())).willReturn(ApiResponse.ok(new WorkSessionResponse(
				100, 10, "purchase", "agent", "이번 주 매입 준비", 1, "input",
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"))));

		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"feature_type\": \"purchase\", \"input_method\": \"agent\", \"title\": \"이번 주 매입 준비\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.session_id").value(100))
				.andExpect(jsonPath("$.data.current_version").value(1))
				.andExpect(jsonPath("$.data.step").value("input"));
	}

	@Test
	void feature_type이_범위_밖이면_400() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"feature_type\": \"delivery\", \"input_method\": \"agent\"}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 필수값이_빠지면_400() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"feature_type\": \"purchase\"}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 없는_매장_또는_남의_매장이면_404_공통_오류() throws Exception {
		given(workSessionService.create(any())).willThrow(ApiException.notFound("매장을 찾을 수 없습니다."));

		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 999, \"feature_type\": \"purchase\", \"input_method\": \"agent\"}"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"))
				.andExpect(jsonPath("$.message").value("매장을 찾을 수 없습니다."));
	}
}
