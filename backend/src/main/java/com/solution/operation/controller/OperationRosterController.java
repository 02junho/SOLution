package com.solution.operation.controller;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.operation.service.input.MenuTypeService;
import com.solution.operation.service.roster.DailyRosterService;
import com.solution.operation.service.roster.RosterChatService;
import com.solution.operation.service.roster.RosterResultService;

/**
 * 하루 근무표 만들기(미리보기, 저장 없음).
 * 요청: {"operation_form": {...폼 값...}, "owner_start_time": "08:00", "owner_end_time": "14:00"}
 * 사장님 근무시간을 비우면 영업시간 내내로 본다.
 */
@RestController
@RequestMapping("/api/v1/operation")
public class OperationRosterController {

	private final DailyRosterService service;
	private final MenuTypeService menuTypes;
	private final RosterResultService results;
	private final RosterChatService chats;

	public OperationRosterController(DailyRosterService service, MenuTypeService menuTypes, RosterResultService results,
			RosterChatService chats) {
		this.service = service;
		this.menuTypes = menuTypes;
		this.results = results;
		this.chats = chats;
	}

	/** 말로 고치기: {"message", "fields", "state", "workers", "result"} → intent·바꿀 칸·답장. 저장하지 않는다. */
	@PostMapping("/roster-chat")
	public ApiResponse<Map<String, Object>> rosterChat(@RequestBody Map<String, Object> body) {
		return chats.chat(body);
	}

	/** 추천 근무표 결과 설명: {"result", "fallback"} → 두세 문장(결과에 없는 숫자가 있으면 fallback). */
	@PostMapping("/roster-explain")
	public ApiResponse<Map<String, Object>> rosterExplain(@RequestBody Map<String, Object> body) {
		return chats.explain(body);
	}

	/**
	 * 추천 근무표 3안 계산을 시작한다(뒤에서 계산해 업무 결과로 저장, 1~2분). 바로 state=RUNNING을 돌려준다.
	 * 요청: {"input_version_id", "days", "workers", "min_gain_sec"(선택)}, 헤더 Idempotency-Key 필수.
	 * 같은 키로 다시 보내면 새로 시작하지 않고 상태를 돌려준다. 고른 안은 공통 확정 API로 저장한다.
	 */
	@PostMapping("/sessions/{sessionId}/roster-results")
	public ApiResponse<Map<String, Object>> startRosterResult(@PathVariable long sessionId, @RequestBody Map<String, Object> body,
			@RequestHeader(value = "Idempotency-Key", required = false) String idempotencyKey) {
		return results.start(sessionId, body, idempotencyKey);
	}

	/** 계산 상태: state = RUNNING / DONE(result_id, summary) / FAILED / LOST(서버 재시작 등으로 기록 없음). */
	@GetMapping("/sessions/{sessionId}/roster-results")
	public ApiResponse<Map<String, Object>> rosterResultStatus(@PathVariable long sessionId,
			@RequestParam("input_version_id") long inputVersionId, @RequestParam("request_key") String requestKey) {
		return results.status(sessionId, inputVersionId, requestKey);
	}

	/** 가게 파일 메뉴 이름 → 제조 유형(낱말로 모른 이름만). 요청: {"names": [...], "types": [{"id", "label"}]} */
	@PostMapping("/menu-types")
	public ApiResponse<Map<String, Object>> menuTypes(@RequestBody Map<String, Object> body) {
		return menuTypes.classify(body);
	}

	@PostMapping("/daily-rosters")
	public ApiResponse<Map<String, Object>> dailyRoster(@RequestBody Map<String, Object> body) {
		return service.plan(body, text(body.get("owner_start_time")), text(body.get("owner_end_time")));
	}

	/** 일주일 근무표(미리보기). 요청: {"days": [...], "workers": [...], "weekly_mode": "COMPARE"} */
	@PostMapping("/weekly-rosters")
	public ApiResponse<Map<String, Object>> weeklyRoster(@RequestBody Map<String, Object> body) {
		return service.week(body);
	}

	/**
	 * 일주일 근무표 한 번에(미리보기).
	 * 요청: {"days": [{"day": "MON", "operation_form": {...}, "owner_start_time": "07:00", "owner_end_time": "15:00"}],
	 * "workers": [...], "weekly_mode": "COMPARE"}
	 */
	@PostMapping("/weekly-plans")
	public ApiResponse<Map<String, Object>> weeklyPlan(@RequestBody Map<String, Object> body) {
		return service.weekPlan(body);
	}

	/** 추천 근무표 3안(미리보기). 요청은 weekly-plans와 같고 weekly_mode 대신 min_gain_sec(선택). */
	@PostMapping("/roster-options")
	public ApiResponse<Map<String, Object>> rosterOptions(@RequestBody Map<String, Object> body) {
		return service.rosterOptions(body);
	}

	private static String text(Object value) {
		return value instanceof String s ? s : null;
	}
}
