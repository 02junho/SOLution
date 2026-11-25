package com.solution.session.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.WorkSessionContextResponse;
import com.solution.session.dto.WorkSessionListResponse;
import com.solution.session.dto.WorkSessionResponse;
import com.solution.session.service.WorkSessionEventService;
import com.solution.session.service.WorkSessionService;

@WebMvcTest(WorkSessionController.class)
class WorkSessionControllerTest {

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private WorkSessionService workSessionService;

	@MockitoBean
	private WorkSessionEventService workSessionEventService;

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
	void 제목이_200자면_통과한다() throws Exception {
		given(workSessionService.create(any())).willReturn(ApiResponse.ok(new WorkSessionResponse(
				100, 10, "purchase", "agent", "a".repeat(200), 1, "input",
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"))));

		String title = "a".repeat(200);
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"feature_type\": \"purchase\", \"input_method\": \"agent\", \"title\": \"" + title + "\"}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"));
	}

	@Test
	void 제목이_201자면_400() throws Exception {
		String title = "a".repeat(201);
		mockMvc.perform(post("/api/v1/work-sessions")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"store_id\": 10, \"feature_type\": \"purchase\", \"input_method\": \"agent\", \"title\": \"" + title + "\"}"))
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

	@Test
	void 업무_문맥을_복원한다() throws Exception {
		given(workSessionService.getContext(100L)).willReturn(ApiResponse.ok(new WorkSessionContextResponse(
				100, 10, "purchase", "agent", "이번 주 매입 준비", 2, 1002L, false, "input",
				null, false,
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"),
				OffsetDateTime.parse("2026-11-13T10:12:00+09:00"), null)));

		mockMvc.perform(get("/api/v1/work-sessions/100"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.session_id").value(100))
				.andExpect(jsonPath("$.data.current_version_id").value(1002))
				.andExpect(jsonPath("$.data.input_confirmed").value(false))
				.andExpect(jsonPath("$.data.has_confirmation").value(false));
	}

	@Test
	void 없는_업무_조회는_404() throws Exception {
		given(workSessionService.getContext(999L)).willThrow(ApiException.notFound("업무를 찾을 수 없습니다."));

		mockMvc.perform(get("/api/v1/work-sessions/999"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"))
				.andExpect(jsonPath("$.message").value("업무를 찾을 수 없습니다."));
	}
	@ParameterizedTest
	@ValueSource(strings = {"not-a-number", "9223372036854775808"})
	void 업무번호가_long_형식이_아니면_500_대신_400(String sessionId) throws Exception {
		mockMvc.perform(get("/api/v1/work-sessions/" + sessionId))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 업무_목록을_돌려준다() throws Exception {
		given(workSessionService.list(null, null, 20)).willReturn(ApiResponse.ok(new WorkSessionListResponse(
				List.of(new WorkSessionListResponse.Item(100, "purchase", "이번 주 매입 준비", "result", 2,
						OffsetDateTime.parse("2026-11-13T10:12:00+09:00"))),
				null)));

		mockMvc.perform(get("/api/v1/work-sessions"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.items[0].session_id").value(100))
				.andExpect(jsonPath("$.data.items[0].feature_type").value("purchase"))
				.andExpect(jsonPath("$.data.next_cursor").isEmpty());
	}

	@Test
	void 목록은_feature_type_필터와_size를_서비스에_전달한다() throws Exception {
		given(workSessionService.list("operation", null, 5)).willReturn(ApiResponse.ok(
				new WorkSessionListResponse(List.of(), null)));

		mockMvc.perform(get("/api/v1/work-sessions")
				.param("feature_type", "operation")
				.param("size", "5"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.items").isArray());
	}

	@ParameterizedTest
	@ValueSource(strings = {"abc", "1.5", "2147483648"})
	void 목록_size가_정수_범위가_아니면_400(String size) throws Exception {
		mockMvc.perform(get("/api/v1/work-sessions").param("size", size))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 폼_이벤트는_입력검토를_돌려준다() throws Exception {
		given(workSessionEventService.handleEvent(anyLong(), any(), any())).willReturn(new ApiResponse<>(
				ResponseStatus.OK, Map.of("session_id", 100, "version_no", 1, "step", "review"),
				"입력을 저장했어요. 입력을 확인해 주세요."));

		mockMvc.perform(post("/api/v1/work-sessions/100/events")
				.header("X-Request-Key", "key-1")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"form\", \"form_input\": {\"budget_krw\": 100000}}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.step").value("review"));
	}

	@Test
	void 이벤트타입이_범위밖이면_400() throws Exception {
		mockMvc.perform(post("/api/v1/work-sessions/100/events")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"delete\"}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 없는_업무에_이벤트를_보내면_404() throws Exception {
		given(workSessionEventService.handleEvent(anyLong(), any(), any()))
				.willThrow(ApiException.notFound("업무를 찾을 수 없습니다."));

		mockMvc.perform(post("/api/v1/work-sessions/999/events")
				.contentType(MediaType.APPLICATION_JSON)
				.content("{\"event_type\": \"form\", \"form_input\": {\"a\": 1}}"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.message").value("업무를 찾을 수 없습니다."));
	}

}
