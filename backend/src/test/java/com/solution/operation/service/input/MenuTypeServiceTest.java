package com.solution.operation.service.input;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;

@SuppressWarnings({"unchecked", "rawtypes"})
class MenuTypeServiceTest {

	private static final List<Map<String, String>> TYPES = List.of(Map.of("id", "iced_americano", "label", "커피 · 아이스"));

	@Test
	void 메뉴_이름과_유형_목록만_넘긴다() {
		AiServerClient client = mock(AiServerClient.class);
		ApiResponse<Map<String, Object>> answer = ApiResponse.ok(Map.of("source", "LLM"));
		when(client.post(eq("/tools/simulation/menu-types"), any(), any(), any())).thenReturn((ApiResponse) answer);
		var service = new MenuTypeService(client);
		assertThat(service.classify(Map.of("names", List.of("시그니처"), "types", TYPES, "rows", List.of("원본")))).isSameAs(answer);
		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(client).post(eq("/tools/simulation/menu-types"), sent.capture(), any(), any());
		assertThat(sent.getValue()).containsOnlyKeys("names", "types");
	}

	@Test
	void 이름이_없거나_길면_막는다() {
		var service = new MenuTypeService(mock(AiServerClient.class));
		assertThatThrownBy(() -> service.classify(Map.of("names", List.of(), "types", TYPES))).hasMessageContaining("메뉴 이름");
		assertThatThrownBy(() -> service.classify(Map.of("names", List.of("가".repeat(41)), "types", TYPES)))
				.hasMessageContaining("메뉴 이름");
		assertThatThrownBy(() -> service.classify(Map.of("names", List.of("A")))).hasMessageContaining("유형 목록");
	}
}
