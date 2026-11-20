package com.solution.explain;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.spy;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.doReturn;

import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.jdbc.core.JdbcTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;

import tools.jackson.databind.json.JsonMapper;

@SuppressWarnings("unchecked")
class ResultExplanationServiceTest {

	private AiServerClient client;
	private CurrentOwner owner;
	private ResultExplanationService service;

	private static final String PURCHASE = """
			{"choices":[{"choice_key":"purchase_1","label":"총비용 최소","total_krw":113280,"delivery_count":2}],
			 "warnings":[],"assumptions":[]}""";

	@BeforeEach
	void setUp() {
		client = mock(AiServerClient.class);
		owner = mock(CurrentOwner.class);
		given(owner.key()).willReturn("demo-owner");
		service = spy(new ResultExplanationService(mock(JdbcTemplate.class), client, owner, JsonMapper.builder().build()));
	}

	private void stored(String featureType, String owner, String status, String summary) {
		doReturn(Optional.of(new ResultExplanationService.Source(7L, 100L, 1L, featureType, owner, status, summary)))
				.when(service).find(7L);
	}

	@Test
	void 저장된_결과의_요약을_추려_설명을_요청하고_응답을_그대로_돌려준다() {
		stored("purchase", "demo-owner", "ok", PURCHASE);
		Map<String, Object> data = Map.of("source", "template",
				"explanation", Map.of("headline", "총비용 최소: 113,280원.", "per_choice", java.util.List.of()));
		ArgumentCaptor<Map<String, Object>> body = ArgumentCaptor.forClass(Map.class);
		given(client.post(eq(ResultExplanationService.PATH), body.capture(), eq("key-1"),
				any(ParameterizedTypeReference.class))).willReturn(ApiResponse.ok(data));

		ApiResponse<Map<String, Object>> response = service.explain(7L, "key-1");

		assertThat(response.data()).isEqualTo(data);
		assertThat(body.getValue()).containsEntry("result_id", 7L).containsEntry("session_id", 100L)
				.containsEntry("store_id", 1L).containsEntry("feature_type", "purchase");
		assertThat((Map<String, Object>) body.getValue().get("result_summary")).containsKey("choices");
	}

	@Test
	void 남의_결과이거나_없으면_404이고_AI를_부르지_않는다() {
		stored("purchase", "someone-else", "ok", PURCHASE);
		assertThatThrownBy(() -> service.explain(7L, null)).isInstanceOf(ApiException.class)
				.hasMessage("결과를 찾을 수 없어요.");
		doReturn(Optional.empty()).when(service).find(7L);
		assertThatThrownBy(() -> service.explain(7L, null)).isInstanceOf(ApiException.class);
		verify(client, never()).post(anyString(), any(), anyString(), any(ParameterizedTypeReference.class));
	}

	@Test
	void 계산이_끝나지_않은_결과는_400() {
		stored("purchase", "demo-owner", "infeasible", PURCHASE);
		assertThatThrownBy(() -> service.explain(7L, null)).isInstanceOf(ApiException.class)
				.hasMessage("계산이 끝난 결과만 설명할 수 있어요.");
	}

	@Test
	void 설명이_빠진_응답은_AI_서버_오류로_본다() {
		stored("operation", "demo-owner", "ok", "{\"choices\":[]}");
		given(client.post(anyString(), any(), anyString(), any(ParameterizedTypeReference.class)))
				.willReturn(ApiResponse.ok(Map.of("source", "template")));
		assertThatThrownBy(() -> service.explain(7L, "k")).isInstanceOf(AiServerException.class);
	}
}
