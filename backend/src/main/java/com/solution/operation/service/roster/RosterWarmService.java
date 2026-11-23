package com.solution.operation.service.roster;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.atomic.AtomicBoolean;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import com.solution.common.response.ApiResponse;

import jakarta.annotation.PreDestroy;

/**
 * 추천 근무표 미리 계산(운영 2번 속도 개선 E). 저장하지 않는다.
 *
 * <p>쉬운 화면의 조건 확인 카드가 뜨면, 사장님이 카드를 읽는 동안 같은 조건으로 계산을 미리 돌려 ai-server의 요일 기억을
 * 채운다(E). 결과 화면에서는 사장님이 자주 바꾸는 목표 대기(3·5·7분)의 다른 값을 차례로 미리 계산한다(G).
 * 사장님이 "추천 근무표 만들기"를 누르면 진짜 계산(RosterResultService)이 끝난 요일은 기억에서 꺼내고, 아직 도는
 * 요일은 이어받는다(ai-server day_cache). 결과는 버린다.
 *
 * <p>안전장치(2코어 배포 서버 기준):
 * <ul>
 * <li>미리 계산은 서버 전체에서 한 번에 1건. 돌고 있으면 새 요청은 건너뛴다(WARM_RUNNING).</li>
 * <li>진짜 계산이 하나라도 돌고 있으면 시작하지 않는다(REAL_RUNNING). 진짜 계산의 CPU를 뺏지 않게.</li>
 * <li>요청은 바로 답하고 계산은 뒤에서 한다(백엔드 스레드를 1분씩 잡지 않게).</li>
 * <li>ai-server에 background=true로 보내 낮은 우선순위 프로세스로 돌린다. 그사이 진짜 계산이 오면 OS가 진짜 계산에 CPU를 먼저 준다.</li>
 * </ul>
 */
@Service
public class RosterWarmService {

	private static final Logger log = LoggerFactory.getLogger(RosterWarmService.class);
	/** ai-server로 넘기는 키. 계산 결과에 영향을 주는 것만(진짜 계산과 같은 조건 = 같은 기억 키). */
	static final List<String> KEYS = List.of("days", "workers", "min_gain_sec", "compare_holiday_pay");

	private final DailyRosterService rosters;
	private final RosterResultService results;
	private final Executor executor;
	private final AtomicBoolean busy = new AtomicBoolean();

	@Autowired
	public RosterWarmService(DailyRosterService rosters, RosterResultService results) {
		this(rosters, results, Executors.newSingleThreadExecutor(task -> {
			Thread thread = new Thread(task, "roster-warm");
			thread.setDaemon(true);
			return thread;
		}));
	}

	/** 테스트는 실행기를 넣는다. */
	RosterWarmService(DailyRosterService rosters, RosterResultService results, Executor executor) {
		this.rosters = rosters;
		this.results = results;
		this.executor = executor;
	}

	@PreDestroy
	void shutdown() {
		if (executor instanceof ExecutorService pool) {
			pool.shutdownNow();
		}
	}

	/** 미리 계산 시작. 답: {"state": "STARTED" | "SKIPPED", "reason": 건너뛴 이유}. 화면은 결과를 기다리지 않는다. */
	public ApiResponse<Map<String, Object>> warm(Map<String, Object> body) {
		if (!(body.get("days") instanceof List<?> days) || days.isEmpty() || !(body.get("workers") instanceof List<?>)) {
			return skipped("INVALID");
		}
		if (results.runningCount() > 0) {
			return skipped("REAL_RUNNING");
		}
		if (!busy.compareAndSet(false, true)) {
			return skipped("WARM_RUNNING");
		}
		Map<String, Object> request = new LinkedHashMap<>();
		for (String key : KEYS) {
			if (body.get(key) != null) {
				request.put(key, body.get(key));
			}
		}
		request.put("background", true);
		try {
			executor.execute(() -> {
				try {
					rosters.rosterOptions(request);
				} catch (RuntimeException failure) {
					// 미리 계산은 실패해도 사장님에게 보이지 않는다(진짜 계산이 다시 한다).
					log.info("근무표 미리 계산 실패: {}", failure.getMessage());
				} finally {
					busy.set(false);
				}
			});
		} catch (RejectedExecutionException full) {
			busy.set(false);
			return skipped("WARM_RUNNING");
		}
		return ApiResponse.ok(Map.of("state", "STARTED"));
	}

	private static ApiResponse<Map<String, Object>> skipped(String reason) {
		return ApiResponse.ok(Map.of("state", "SKIPPED", "reason", reason));
	}
}
