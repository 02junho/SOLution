package com.solution.operation.service.roster;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.LocalDate;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;
import com.solution.operation.service.input.OperationInputBuilder;

@SuppressWarnings("unchecked")
class DailyRosterServiceTest {

	private static final LocalDate DAY = LocalDate.of(2026, 11, 20);

	private static Map<String, Object> stored(boolean owner, Boolean minor) {
		Map<String, Object> form = new HashMap<>();
		form.put("is_owner_working", owner);
		form.put("hourly_wage_krw", 10320);
		form.put("is_staff_minor", minor);
		Map<String, Integer> slots = new LinkedHashMap<>();
		for (int h = 8; h < 20; h++) {
			slots.put(String.format("%02d:00-%02d:00", h, h + 1), h == 12 || h == 13 ? 20 : 8);
		}
		form.put("orders_by_slot", slots);
		form.put("peak_start_time", "12:00");
		form.put("peak_end_time", "14:00");
		return Map.of(OperationInputBuilder.FORM_KEY, form);
	}

	@Test
	void 근무표_요청은_손님_조건과_사람_조건을_함께_만든다() {
		Map<String, Object> body = OperationInputBuilder.rosterRequest(stored(true, null), "08:00", "14:00", DAY);
		assertThat((Map<String, Object>) body.get("scenario")).containsKey("orders_by_slot")
				.containsEntry("peak_start_time", "12:00");
		assertThat((Map<String, Object>) body.get("owner")).containsEntry("is_working", true)
				.containsEntry("start_time", "08:00").containsEntry("end_time", "14:00");
		assertThat(body).containsEntry("hourly_wage_krw", 10320).containsEntry("is_staff_minor", false)
				.containsEntry("business_date", "2026-11-20").doesNotContainKey("include_events");
		// 비우면 영업시간 내내
		Map<String, Object> allDay = OperationInputBuilder.rosterRequest(stored(true, null), null, null, DAY);
		assertThat((Map<String, Object>) allDay.get("owner")).containsEntry("start_time", "08:00").containsEntry("end_time", "20:00");
	}

	@Test
	void 연소자도_근무표는_만들고_사장님_시간은_영업시간_안이어야_한다() {
		Map<String, Object> minor = OperationInputBuilder.rosterRequest(stored(false, true), null, null, DAY);
		assertThat(minor).containsEntry("is_staff_minor", true);
		assertThat((Map<String, Object>) minor.get("owner")).containsEntry("is_working", false).doesNotContainKey("start_time");
		assertThatThrownBy(() -> OperationInputBuilder.rosterRequest(stored(true, null), "07:00", "12:00", DAY))
				.hasMessageContaining("사장님 근무시간");
		assertThatThrownBy(() -> OperationInputBuilder.rosterRequest(stored(true, null), "09:15", "12:00", DAY))
				.hasMessageContaining("30분 단위");
		assertThatThrownBy(() -> OperationInputBuilder.rosterRequest(Map.of(), null, null, DAY))
				.hasMessageContaining("operation_form");
	}

	@Test
	void 서비스는_ai_server_근무표_결과를_그대로_돌려준다() {
		var client = mock(AiServerClient.class);
		ApiResponse<Map<String, Object>> answer = ApiResponse.ok(Map.of("model_version", "operation.daily_roster.v1"));
		when(client.post(eq("/tools/simulation/daily-roster"), any(), any(), any())).thenReturn((ApiResponse) answer);
		var result = new DailyRosterService(client).plan(stored(true, null), null, null);
		assertThat(result.data()).containsEntry("model_version", "operation.daily_roster.v1");
		ArgumentCaptor<String> key = ArgumentCaptor.forClass(String.class);
		verify(client).post(eq("/tools/simulation/daily-roster"), any(), key.capture(), any());
		assertThat(key.getValue()).endsWith(":roster");
	}

	@Test
	void 일주일_근무표_한_번에는_요일마다_하루_조건을_만들어_넘긴다() {
		var client = mock(AiServerClient.class);
		ApiResponse<Map<String, Object>> answer = ApiResponse.ok(Map.of("model_version", "operation.week_plan.v1"));
		when(client.post(eq("/tools/simulation/week-plan"), any(), any(), any())).thenReturn((ApiResponse) answer);
		Map<String, Object> mon = new HashMap<>(stored(true, null));
		mon.put("day", "MON");
		mon.put("owner_start_time", "08:00");
		mon.put("owner_end_time", "14:00");
		Map<String, Object> sun = new HashMap<>(stored(false, null));
		sun.put("day", "SUN");
		var service = new DailyRosterService(client);
		assertThat(service.weekPlan(Map.of("days", java.util.List.of(mon, sun), "workers", java.util.List.of(Map.of("worker_key", "A"))))
				.data()).containsEntry("model_version", "operation.week_plan.v1");
		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(client).post(eq("/tools/simulation/week-plan"), sent.capture(), any(), any());
		var days = (java.util.List<Map<String, Object>>) sent.getValue().get("days");
		assertThat(days).extracting(d -> d.get("day")).containsExactly("MON", "SUN");
		Map<String, Object> monRoster = (Map<String, Object>) days.get(0).get("roster");
		assertThat((Map<String, Object>) monRoster.get("owner")).containsEntry("start_time", "08:00");
		assertThat((Map<String, Object>) ((Map<String, Object>) days.get(1).get("roster")).get("owner")).containsEntry("is_working", false);
		assertThatThrownBy(() -> service.weekPlan(Map.of("days", java.util.List.of(Map.of("x", 1)), "workers", java.util.List.of(Map.of()))))
				.hasMessageContaining("요일");
	}

	@Test
	void 추천_근무표는_요일_조건과_대기_감소_기준만_넘긴다() {
		var client = mock(AiServerClient.class);
		ApiResponse<Map<String, Object>> answer = ApiResponse.ok(Map.of("model_version", "operation.roster_options.v1"));
		when(client.post(eq("/tools/simulation/roster-options"), any(), any(), any())).thenReturn((ApiResponse) answer);
		Map<String, Object> mon = new HashMap<>(stored(true, null));
		mon.put("day", "MON");
		var service = new DailyRosterService(client);
		assertThat(service.rosterOptions(Map.of("days", java.util.List.of(mon), "workers", java.util.List.of(Map.of("worker_key", "A")),
				"min_gain_sec", 45, "weekly_mode", "COMPARE")).data()).containsEntry("model_version", "operation.roster_options.v1");
		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(client).post(eq("/tools/simulation/roster-options"), sent.capture(), any(), any());
		assertThat(sent.getValue()).containsOnlyKeys("days", "workers", "min_gain_sec").containsEntry("min_gain_sec", 45);
		assertThatThrownBy(() -> service.rosterOptions(Map.of("days", java.util.List.of(), "workers", java.util.List.of())))
				.hasMessageContaining("직원 명단");
	}

	@Test
	void 일주일_근무표는_요일과_명단을_넘기고_비어_있으면_막는다() {
		var client = mock(AiServerClient.class);
		ApiResponse<Map<String, Object>> answer = ApiResponse.ok(Map.of("model_version", "operation.weekly_roster.v1"));
		when(client.post(eq("/tools/simulation/weekly-roster"), any(), any(), any())).thenReturn((ApiResponse) answer);
		var service = new DailyRosterService(client);
		Map<String, Object> body = Map.of("days", java.util.List.of(Map.of("day", "MON", "shifts", java.util.List.of())),
				"workers", java.util.List.of(Map.of("worker_key", "A")));
		assertThat(service.week(body).data()).containsEntry("model_version", "operation.weekly_roster.v1");
		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(client).post(eq("/tools/simulation/weekly-roster"), sent.capture(), any(), any());
		assertThat(sent.getValue()).containsEntry("weekly_mode", "COMPARE").containsKeys("days", "workers");
		assertThatThrownBy(() -> service.week(Map.of("days", java.util.List.of(), "workers", java.util.List.of())))
				.hasMessageContaining("직원 명단");
	}
}
