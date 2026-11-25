package com.solution.operation.controller;

import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;

@WebMvcTest(OperationInputController.class)
class OperationInputControllerTest {

	@Autowired private MockMvc mvc;

	@Test
	void 폼_값을_snake_case로_받아_운영_입력을_돌려준다() throws Exception {
		mvc.perform(post("/api/v1/operation/input-drafts").contentType(MediaType.APPLICATION_JSON)
				.content("{\"business_date\":\"2026-11-18\",\"daily_orders\":150,\"is_owner_working\":true,\"hourly_wage_krw\":10320}"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.input.wage_year").value(2026))
				.andExpect(jsonPath("$.data.input.simulation.scenario.daily_orders").value(150))
				.andExpect(jsonPath("$.data.input.labor.plans.length()").value(3))
				.andExpect(jsonPath("$.data.plan_descriptions.length()").value(3));
	}

	@Test
	void 필수_값이_없으면_400() throws Exception {
		mvc.perform(post("/api/v1/operation/input-drafts").contentType(MediaType.APPLICATION_JSON)
				.content("{\"daily_orders\":150}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.status").value("error"));
	}

	@Test
	void 잘못된_시각은_사유_코드와_함께_400() throws Exception {
		mvc.perform(post("/api/v1/operation/input-drafts").contentType(MediaType.APPLICATION_JSON)
				.content("{\"business_date\":\"2026-11-18\",\"daily_orders\":150,\"is_owner_working\":true,"
						+ "\"hourly_wage_krw\":10320,\"last_order_time\":\"17:00\"}"))
				.andExpect(status().isBadRequest())
				.andExpect(jsonPath("$.data.detail_code").value("INVALID_REQUEST"))
				.andExpect(jsonPath("$.message").value(containsString("라스트 오더")));
	}
}
