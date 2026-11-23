package com.solution.operation.service.roster;

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
class RosterChatServiceTest {

	private static final List<Map<String, Object>> FIELDS = List.of(Map.of("key", "target_wait_min", "label", "목표 대기", "type", "int", "min", 2, "max", 10));

	@Test
	void 말과_칸_목록만_넘긴다() {
		AiServerClient client = mock(AiServerClient.class);
		when(client.post(eq("/tools/simulation/roster-chat"), any(), any(), any())).thenReturn((ApiResponse) ApiResponse.ok(Map.of("intent", "EDIT")));
		var service = new RosterChatService(client);
		assertThat(service.chat(Map.of("message", "목표 3분", "fields", FIELDS, "state", Map.of(), "extra", "x")).data())
				.containsEntry("intent", "EDIT");
		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(client).post(eq("/tools/simulation/roster-chat"), sent.capture(), any(), any());
		assertThat(sent.getValue()).containsOnlyKeys("message", "fields", "state");
	}

	@Test
	void 크기를_막는다() {
		var service = new RosterChatService(mock(AiServerClient.class));
		assertThatThrownBy(() -> service.chat(Map.of("message", "", "fields", FIELDS))).hasMessageContaining("말은");
		assertThatThrownBy(() -> service.chat(Map.of("message", "가".repeat(301), "fields", FIELDS))).hasMessageContaining("말은");
		assertThatThrownBy(() -> service.chat(Map.of("message", "a"))).hasMessageContaining("fields");
		assertThatThrownBy(() -> service.explain(Map.of("result", Map.of()))).hasMessageContaining("result");
		assertThatThrownBy(() -> service.explain(Map.of("result", Map.of("a", 1)))).hasMessageContaining("fallback");
	}
}
