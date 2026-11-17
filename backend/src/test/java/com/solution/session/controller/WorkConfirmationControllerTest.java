package com.solution.session.controller;

import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.time.OffsetDateTime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkConfirmationDetailResponse;
import com.solution.session.service.ConfirmationNotFoundException;
import com.solution.session.service.WorkConfirmationService;

@WebMvcTest(WorkConfirmationController.class)
class WorkConfirmationControllerTest {

	@Autowired private MockMvc mvc;
	@MockitoBean private WorkConfirmationService service;

	@Test
	void 저장된_객체형_경고와_스냅샷도_중첩_JSON으로_반환한다() throws Exception {
		given(service.getDetail(3001)).willReturn(ApiResponse.ok(new WorkConfirmationDetailResponse(
				3001, 2001, 1002, 500, "purchase", "purchase_1", "demo-owner", OffsetDateTime.now(), true,
				"[{\"warning_id\":\"VAT_UNKNOWN\",\"label\":\"부가세 미확인\"}]", "{\"total_krw\":120400}")));
		mvc.perform(get("/api/v1/work-confirmations/3001")).andExpect(status().isOk())
				.andExpect(jsonPath("$.data.is_current_version").value(true))
				.andExpect(jsonPath("$.data.acknowledged_warnings_json[0].label").value("부가세 미확인"))
				.andExpect(jsonPath("$.data.selected_snapshot_json.total_krw").value(120400));
	}

	@Test
	void 없는_확정은_404_코드와_명세_메시지() throws Exception {
		given(service.getDetail(9999)).willThrow(new ConfirmationNotFoundException());
		mvc.perform(get("/api/v1/work-confirmations/9999")).andExpect(status().isNotFound())
				.andExpect(jsonPath("$.data.detail_code").value("CONFIRMATION_NOT_FOUND"))
				.andExpect(jsonPath("$.message").value("확정 기록을 찾을 수 없습니다."));
	}

	@ParameterizedTest @ValueSource(strings = {"abc", "9223372036854775808"})
	void 경로번호_변환오류는_400(String id) throws Exception {
		mvc.perform(get("/api/v1/work-confirmations/" + id)).andExpect(status().isBadRequest());
	}
}
