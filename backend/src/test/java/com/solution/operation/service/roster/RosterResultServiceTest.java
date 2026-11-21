package com.solution.operation.service.roster;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.common.response.ApiResponse;
import com.solution.operation.service.OperationResultRepository;
import com.solution.operation.service.OperationResultRepository.SessionVersion;
import com.solution.operation.service.OperationResultRepository.StoredResult;
import com.solution.session.service.CalculationRuns;

import tools.jackson.databind.json.JsonMapper;

@SuppressWarnings({"unchecked", "rawtypes"})
class RosterResultServiceTest {

	private static Map<String, Object> option(String key, String title, int people, int more, long cost, double wait) {
		return Map.of("key", key, "title", title, "extra_by_day", Map.of("MON", 1),
				"peak_wait_sec", Map.of("MON", wait), "plan_cost_krw", cost,
				"weekly", Map.of("people_used", people, "unfilled", List.of()),
				"shortfall", Map.of("unfilled_hours", more * 10, "more_people_under_15h", more),
				"days", Map.of("MON", Map.of("shifts", List.of())));
	}

	private static Map<String, Object> options() {
		return Map.of("model_version", "operation.roster_options.v1", "min_gain_sec", 30,
				"options", List.of(option("SAVE", "아끼는 안", 9, 0, 1_274_520, 222),
						option("RECOMMENDED", "추천안", 13, 0, 1_775_040, 156),
						option("ROOMY", "여유 안", 13, 4, 2_352_960, 150)),
				"holiday_compare", Map.of("plan_cost_krw", 1_717_248, "weekly", Map.of("people_used", 8)),
				"days", Map.of("MON", Map.of("windows", List.of())), "skipped_days", List.of(), "assumptions", List.of("가정"));
	}

	@Test
	void 공통_확정이_읽는_모양으로_세_안을_요약한다() {
		Map<String, Object> summary = RosterResultService.summary(options());
		assertThat(summary).containsEntry("result_kind", "ROSTER_OPTIONS").containsEntry("complete", true)
				.containsEntry("recommended_choice_key", "RECOMMENDED");
		List<Map<String, Object>> choices = (List<Map<String, Object>>) summary.get("choices");
		assertThat(choices).extracting(c -> c.get("choice_key")).containsExactly("SAVE", "RECOMMENDED", "ROOMY");
		assertThat(choices.get(1)).containsEntry("people_used", 13).containsEntry("weekly_cost_krw", 1_775_040L)
				.containsEntry("peak_wait_sec", 156.0);
		List<Map<String, Object>> warnings = (List<Map<String, Object>>) summary.get("warnings");
		// 운영 결과 확정에 필요한 필수 경고 + 못 채운 자리가 있는 안에만 붙는 경고
		assertThat(warnings.get(0)).containsEntry("warning_id", "SIMULATED_CONDITIONS").containsEntry("requires_ack", true)
				.containsEntry("choice_keys", null);
		assertThat(warnings.get(1)).containsEntry("warning_id", "UNFILLED_SHIFTS").containsEntry("choice_keys", List.of("ROOMY"));
		assertThat((String) summary.get("message")).isEqualTo("추천안: 바쁜 시간 대기 3.7분 → 2.6분, 주 인건비 1,775,040원, 알바 13명(모두 주 15시간 미만).");
	}

	@Test
	void 상세에는_근무표_전체와_계산에_쓴_조건을_남긴다() {
		Map<String, Object> body = Map.of("input_version_id", 7, "days", List.of(Map.of("day", "MON")), "workers", List.of(Map.of("name", "A")));
		Map<String, Object> detail = RosterResultService.detail(options(), body);
		List<Map<String, Object>> choices = (List<Map<String, Object>>) detail.get("choices");
		assertThat(choices.get(0)).containsEntry("choice_key", "SAVE").doesNotContainKey("key").containsKey("days");
		assertThat((Map<String, Object>) detail.get("request")).containsOnlyKeys("days", "workers");
	}

	private record Fixture(RosterResultService service, OperationResultRepository repository, DailyRosterService rosters,
			CalculationRuns runs, List<Runnable> held) {
	}

	/** hold = true면 계산을 바로 돌리지 않고 붙잡아 둔다("계산 중" 상태 확인용). */
	private static Fixture fixture(SessionVersion version, boolean hold) {
		return fixture(version, hold, null);
	}

	private static Fixture fixture(SessionVersion version, boolean hold, Executor custom) {
		var repository = mock(OperationResultRepository.class);
		var rosters = mock(DailyRosterService.class);
		var transaction = mock(TransactionTemplate.class);
		when(transaction.execute(any())).thenAnswer(inv -> ((TransactionCallback) inv.getArgument(0)).doInTransaction(null));
		org.mockito.Mockito.doAnswer(inv -> {
			((java.util.function.Consumer) inv.getArgument(0)).accept(null);
			return null;
		}).when(transaction).executeWithoutResult(any());
		var ids = mock(IdGenerator.class);
		when(ids.next()).thenReturn(99L);
		when(repository.findSessionVersion(1L, 7L)).thenReturn(Optional.of(version));
		// 저장하면 그다음부터 요청 키로 찾을 수 있다.
		AtomicReference<StoredResult> saved = new AtomicReference<>();
		when(repository.findByRequestKey(anyLong(), any())).thenAnswer(inv -> Optional.ofNullable(saved.get()));
		org.mockito.Mockito.doAnswer(inv -> {
			saved.set(inv.getArgument(0));
			return null;
		}).when(repository).insertResult(any(), any(), any());
		when(rosters.rosterOptions(any())).thenReturn((ApiResponse) ApiResponse.ok(options()));
		var runs = mock(CalculationRuns.class);
		when(runs.start(anyLong(), any(), any())).thenReturn(mock(CalculationRuns.Run.class));
		List<Runnable> held = new ArrayList<>();
		Executor executor = custom != null ? custom : hold ? held::add : Runnable::run;
		var service = new RosterResultService(rosters, repository, new CurrentOwner("demo-owner"), ids,
				JsonMapper.builder().build(), transaction, mock(RequestKeyLock.class), runs, executor);
		return new Fixture(service, repository, rosters, runs, held);
	}

	private static SessionVersion version(int versionNo, int current, boolean confirmed) {
		return new SessionVersion(1L, 1L, "operation", current, "demo-owner", 7L, versionNo, "{}",
				confirmed ? OffsetDateTime.now() : null);
	}

	private static final Map<String, Object> BODY = Map.of("input_version_id", 7, "days", List.of(), "workers", List.of());

	@Test
	void 시작은_바로_계산_중을_돌려주고_끝나면_결과로_저장된다() {
		var f = fixture(version(2, 2, true), false);
		var started = f.service().start(1L, BODY, "key-1");
		assertThat(started.data()).containsEntry("state", "RUNNING").containsEntry("request_key", "key-1");
		verify(f.repository()).markStep(1L, 2, "running");
		// 뒤에서 끝난 뒤 상태 조회
		var done = f.service().status(1L, 7L, "key-1");
		assertThat(done.data()).containsEntry("state", "DONE").containsEntry("result_id", 99L);
		assertThat(done.message()).startsWith("추천안:");
		ArgumentCaptor<StoredResult> saved = ArgumentCaptor.forClass(StoredResult.class);
		verify(f.repository()).insertResult(saved.capture(), any(), eq("key-1"));
		assertThat(saved.getValue().summaryJson()).contains("\"result_kind\":\"ROSTER_OPTIONS\"");
		assertThat(saved.getValue().detailJson()).contains("\"request\"");
		verify(f.repository()).markStep(1L, 2, "result");
		// 같은 키로 다시 시작하면 새로 계산하지 않고 저장된 결과
		assertThat(f.service().start(1L, BODY, "key-1").data()).containsEntry("state", "DONE");
		verify(f.rosters(), org.mockito.Mockito.times(1)).rosterOptions(any());
	}

	@Test
	void 계산_중에_같은_키로_다시_보내도_한_번만_돈다() {
		var f = fixture(version(2, 2, true), true);
		f.service().start(1L, BODY, "key-2");
		assertThat(f.service().start(1L, BODY, "key-2").data()).containsEntry("state", "RUNNING");
		assertThat(f.service().status(1L, 7L, "key-2").data()).containsEntry("state", "RUNNING");
		verify(f.runs(), org.mockito.Mockito.times(1)).start(anyLong(), any(), any());
		assertThat(f.held()).hasSize(1);
		f.held().get(0).run();
		assertThat(f.service().status(1L, 7L, "key-2").data()).containsEntry("state", "DONE");
	}

	@Test
	void 계산이_실패하면_FAILED_기록이_없으면_LOST() {
		var f = fixture(version(2, 2, true), false);
		when(f.rosters().rosterOptions(any())).thenThrow(new RuntimeException("ai-server down"));
		f.service().start(1L, BODY, "key-3");
		var failed = f.service().status(1L, 7L, "key-3");
		assertThat(failed.data()).containsEntry("state", "FAILED");
		assertThat(failed.message()).contains("다시 계산");
		verify(f.repository(), never()).insertResult(any(), any(), any());
		assertThat(f.service().status(1L, 7L, "모르는-키").data()).containsEntry("state", "LOST");
	}

	@Test
	void 바뀐_입력이나_확인_전_입력이나_요청키가_없으면_막는다() {
		var stale = fixture(version(1, 2, true), false);
		assertThatThrownBy(() -> stale.service().start(1L, BODY, "k")).hasMessageContaining("조건이 바뀌었어요");
		var unconfirmed = fixture(version(2, 2, false), false);
		assertThatThrownBy(() -> unconfirmed.service().start(1L, BODY, "k")).hasMessageContaining("입력을 먼저 확인");
		var ok = fixture(version(2, 2, true), false);
		assertThatThrownBy(() -> ok.service().start(1L, BODY, null)).hasMessageContaining("Idempotency-Key");
		assertThatThrownBy(() -> ok.service().start(1L, Map.of("days", List.of()), "k")).hasMessageContaining("input_version_id");
		verify(ok.rosters(), never()).rosterOptions(any());
		verify(ok.runs(), never()).start(anyLong(), any(), any());
	}

	@Test
	void 계산이_너무_밀리면_잠시_뒤_다시로_거절하고_계산_중_표시를_푼다() {
		Executor full = task -> {
			throw new java.util.concurrent.RejectedExecutionException("full");
		};
		var f = fixture(version(2, 2, true), false, full);
		CalculationRuns.Run run = mock(CalculationRuns.Run.class);
		when(f.runs().start(anyLong(), any(), any())).thenReturn(run);
		assertThatThrownBy(() -> f.service().start(1L, BODY, "key-4")).hasMessageContaining("잠시 뒤 다시");
		verify(run).close();
		assertThat(f.service().jobCount()).isZero();
		assertThat(f.service().status(1L, 7L, "key-4").data()).containsEntry("state", "LOST");
	}

	@Test
	void 동시_계산_수는_1에서_4_사이이고_기다리는_줄은_정해진_만큼만() throws Exception {
		var small = (java.util.concurrent.ThreadPoolExecutor) RosterResultService.pool(1);
		var big = (java.util.concurrent.ThreadPoolExecutor) RosterResultService.pool(99);
		var none = (java.util.concurrent.ThreadPoolExecutor) RosterResultService.pool(0);
		try {
			assertThat(small.getMaximumPoolSize()).isEqualTo(1);
			assertThat(big.getMaximumPoolSize()).isEqualTo(4);
			assertThat(none.getMaximumPoolSize()).isEqualTo(1);
			assertThat(small.getQueue().remainingCapacity()).isEqualTo(RosterResultService.MAX_QUEUED);
			// 1개 돌고 MAX_QUEUED개 기다리면 그다음은 거절
			var gate = new java.util.concurrent.CountDownLatch(1);
			for (int i = 0; i <= RosterResultService.MAX_QUEUED; i++) {
				small.execute(() -> {
					try {
						gate.await();
					} catch (InterruptedException e) {
						Thread.currentThread().interrupt();
					}
				});
			}
			assertThatThrownBy(() -> small.execute(() -> { })).isInstanceOf(java.util.concurrent.RejectedExecutionException.class);
			gate.countDown();
		} finally {
			small.shutdownNow();
			big.shutdownNow();
			none.shutdownNow();
		}
	}
}
