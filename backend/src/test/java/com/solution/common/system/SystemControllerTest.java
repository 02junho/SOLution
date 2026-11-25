package com.solution.common.system;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import java.util.Map;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;

@WebMvcTest(SystemController.class)
class SystemControllerTest {

	@Autowired
	private MockMvc mockMvc;

	@MockitoBean
	private AiServerClient aiServerClient;

	@MockitoBean
	private JdbcTemplate jdbcTemplate;

	@Test
	void 모두_연결되면_ok() throws Exception {
		given(jdbcTemplate.queryForObject("SELECT 1", Integer.class)).willReturn(1);
		given(aiServerClient.get(eq("/health"), any(ParameterizedTypeReference.class)))
				.willReturn(ApiResponse.ok(Map.of("ai_server", "ok", "database", "ok")));

		mockMvc.perform(get("/api/v1/system/health"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.status").value("ok"))
				.andExpect(jsonPath("$.data.backend").value("ok"))
				.andExpect(jsonPath("$.data.database").value("ok"))
				.andExpect(jsonPath("$.data.ai_server.database").value("ok"));
	}

	@Test
	void DB나_AI_서버가_없어도_어디가_끊겼는지_보여준다() throws Exception {
		given(jdbcTemplate.queryForObject("SELECT 1", Integer.class))
				.willThrow(new DataAccessResourceFailureException("down"));
		given(aiServerClient.get(eq("/health"), any(ParameterizedTypeReference.class)))
				.willThrow(new AiServerException("down"));

		mockMvc.perform(get("/api/v1/system/health"))
				.andExpect(status().isOk())
				.andExpect(jsonPath("$.data.database").value("unavailable"))
				.andExpect(jsonPath("$.data.ai_server").value("unavailable"));
	}

	@Test
	void 없는_주소는_공통_오류_형식() throws Exception {
		mockMvc.perform(get("/api/v1/system/nothing"))
				.andExpect(status().isNotFound())
				.andExpect(jsonPath("$.status").value("error"));
	}
}
