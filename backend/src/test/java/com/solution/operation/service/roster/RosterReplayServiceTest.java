package com.solution.operation.service.roster;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;
import com.solution.operation.service.OperationResultService;

@SuppressWarnings({"unchecked", "rawtypes"})
class RosterReplayServiceTest {

	private static final Map<String, Object> FORM = Map.of("daily_orders", 150, "hourly_wage_krw", 10320,
			"is_owner_working", true, "business_date", "2026-11-20");
	private static final List<Map<String, Object>> SHIFTS = List.of(
			Map.of("worker_key", "OWNER", "is_owner", true, "start_time", "07:00", "end_time", "15:00", "breaks", List.of()),
			Map.of("worker_key", "STAFF_1", "is_owner", false, "start_time", "11:00", "end_time", "14:00", "breaks", List.of()));

	private static Map<String, Object> stored(String kind) {
		Map<String, Object> detail = Map.of(
				"request", Map.of("days", List.of(Map.of("day", "MON", "operation_form", FORM, "owner_start_time", "07:00",
						"owner_end_time", "15:00")), "workers", List.of(Map.of("name", "실명"))),
				"choices", List.of(Map.of("choice_key", "RECOMMENDED", "days", Map.of("MON", Map.of("shifts", SHIFTS)))));
		return Map.of("summary", Map.of("result_kind", kind), "detail", detail);
	}

	@Test
	void 저장된_조건과_근무조만_넘긴다() {
		OperationResultService results = mock(OperationResultService.class);
		AiServerClient client = mock(AiServerClient.class);
		when(results.result(7L, "detail")).thenReturn(ApiResponse.ok(stored("ROSTER_OPTIONS")));
		when(client.post(eq("/tools/simulation/roster-replay"), any(), any(), any()))
				.thenReturn((ApiResponse) ApiResponse.ok(Map.of("trace_schema_version", "operation.trace.v2")));
		var service = new RosterReplayService(results, client);

		assertThat(service.replay(7L, "MON", "RECOMMENDED").data()).containsEntry("trace_schema_version", "operation.trace.v2");

		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(client).post(eq("/tools/simulation/roster-replay"), sent.capture(), any(), any());
		assertThat(sent.getValue()).containsOnlyKeys("roster", "shifts", "choice_key");
		assertThat(sent.getValue().get("shifts")).isEqualTo(SHIFTS);
		assertThat(sent.getValue().toString()).doesNotContain("실명");
	}

	@Test
	void 근무표_결과가_아니거나_요일이_없으면_막는다() {
		OperationResultService results = mock(OperationResultService.class);
		AiServerClient client = mock(AiServerClient.class);
		var service = new RosterReplayService(results, client);
		assertThatThrownBy(() -> service.replay(7L, "MONDAY", "RECOMMENDED")).hasMessageContaining("요일");
		assertThatThrownBy(() -> service.replay(7L, "MON", "BEST")).hasMessageContaining("근무표");

		when(results.result(8L, "detail")).thenReturn(ApiResponse.ok(stored("OPERATION")));
		assertThatThrownBy(() -> service.replay(8L, "MON", "RECOMMENDED")).hasMessageContaining("추천 근무표 결과만");

		when(results.result(9L, "detail")).thenReturn(ApiResponse.ok(stored("ROSTER_OPTIONS")));
		assertThatThrownBy(() -> service.replay(9L, "TUE", "RECOMMENDED")).hasMessageContaining("이 요일");
		assertThatThrownBy(() -> service.replay(9L, "MON", "SAVE")).hasMessageContaining("이 요일");
		verify(client, never()).post(any(), any(), any(), any());
	}
}
