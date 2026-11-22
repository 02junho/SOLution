package com.solution.operation.service.roster;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

@SuppressWarnings("unchecked")
class RosterWarmServiceTest {

	private static final Map<String, Object> BODY = Map.of("input_version_id", 7, "days", List.of(Map.of("day", "MON")),
			"workers", List.of(Map.of("worker_key", "P1")), "compare_holiday_pay", false, "extra", "버림");

	@Test
	void 계산에_필요한_값만_뒤에서_넘기고_바로_답한다() {
		var rosters = mock(DailyRosterService.class);
		var results = mock(RosterResultService.class);
		List<Runnable> held = new ArrayList<>();
		var service = new RosterWarmService(rosters, results, held::add);
		assertThat(service.warm(BODY).data()).containsEntry("state", "STARTED");
		verify(rosters, never()).rosterOptions(any());  // 아직 안 돌림(뒤에서)
		held.get(0).run();
		ArgumentCaptor<Map<String, Object>> sent = ArgumentCaptor.forClass(Map.class);
		verify(rosters).rosterOptions(sent.capture());
		assertThat(sent.getValue()).containsOnlyKeys("days", "workers", "compare_holiday_pay", "background")
				.containsEntry("background", true);
	}

	@Test
	void 미리_계산은_한_번에_한_건() {
		var service = new RosterWarmService(mock(DailyRosterService.class), mock(RosterResultService.class), new ArrayList<Runnable>()::add);
		assertThat(service.warm(BODY).data()).containsEntry("state", "STARTED");
		assertThat(service.warm(BODY).data()).containsEntry("state", "SKIPPED").containsEntry("reason", "WARM_RUNNING");
	}

	@Test
	void 끝나거나_실패하면_다음_미리_계산을_받는다() {
		var rosters = mock(DailyRosterService.class);
		when(rosters.rosterOptions(any())).thenThrow(new RuntimeException("ai-server 오류"));
		var service = new RosterWarmService(rosters, mock(RosterResultService.class), Runnable::run);
		assertThat(service.warm(BODY).data()).containsEntry("state", "STARTED");
		assertThat(service.warm(BODY).data()).containsEntry("state", "STARTED");
	}

	@Test
	void 진짜_계산이_돌고_있으면_시작하지_않는다() {
		var rosters = mock(DailyRosterService.class);
		var results = mock(RosterResultService.class);
		when(results.runningCount()).thenReturn(1L);
		var service = new RosterWarmService(rosters, results, Runnable::run);
		assertThat(service.warm(BODY).data()).containsEntry("state", "SKIPPED").containsEntry("reason", "REAL_RUNNING");
		verify(rosters, never()).rosterOptions(any());
	}

	@Test
	void 요일이나_명단이_없으면_건너뛴다() {
		var service = new RosterWarmService(mock(DailyRosterService.class), mock(RosterResultService.class), Runnable::run);
		assertThat(service.warm(Map.of("days", List.of())).data()).containsEntry("reason", "INVALID");
	}
}
