package com.solution.operation.service.roster;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.operation.service.input.OperationInputBuilder;

/**
 * 하루 근무표 자동 생성(운영 2번 확장). 폼 값 → ai-server /tools/simulation/daily-roster.
 * 시간대별 필요 인원 → 근무조로 덮기 → 휴게 → 휴게까지 넣어 다시 확인한 결과를 그대로 돌려준다. 저장하지 않는다(DB 변경 없음).
 */
@Service
public class DailyRosterService {

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };
	private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");

	private final AiServerClient client;

	public DailyRosterService(AiServerClient client) {
		this.client = client;
	}

	public ApiResponse<Map<String, Object>> plan(Map<String, Object> stored, String ownerStart, String ownerEnd) {
		Map<String, Object> body = OperationInputBuilder.rosterRequest(stored, ownerStart, ownerEnd, LocalDate.now(SEOUL));
		String key = AiServerClient.newRequestKey() + ":roster";
		ApiResponse<Map<String, Object>> response = client.post("/tools/simulation/daily-roster", body, key, RESPONSE);
		if (response == null || response.status() == null || response.status() == ResponseStatus.ERROR) {
			throw new AiServerException("근무표 계산 응답을 받지 못했습니다.");
		}
		return response;
	}

	/**
	 * 일주일 근무표 한 번에: 요일마다 폼 값(operation_form)과 사장님 근무시간을 받아 하루 근무표 조건으로 바꾸고,
	 * 직원 명단과 함께 ai-server /tools/simulation/week-plan으로 넘긴다. 요일별 필요 인원 → 두 근무조(주휴 포함 /
	 * 주 15시간 미만) → 명단 배정을 ai-server가 한다. 저장하지 않는다.
	 */
	public ApiResponse<Map<String, Object>> weekPlan(Map<String, Object> body) {
		Map<String, Object> request = weekRequest(body);
		request.put("weekly_mode", body.getOrDefault("weekly_mode", "COMPARE"));
		return call("/tools/simulation/week-plan", request, ":week", "일주일 근무표 응답을 받지 못했습니다.");
	}

	/**
	 * 추천 근무표 3안(아끼는/추천/여유): 요청 모양은 weekPlan과 같다(요일별 폼 값 + 사장님 근무 + 직원 명단).
	 * ai-server /tools/simulation/roster-options가 바쁜 시간(최대 2구간)에만 사람을 더해 비교하고, 세 안을 주 15시간 미만으로 배정한다.
	 * min_gain_sec(선택)는 "한 명 더 쓸 만하다"고 보는 바쁜 시간 대기 감소(초), compare_holiday_pay(선택, 기본 true)는 주휴 비교 여부. 저장하지 않는다.
	 */
	public ApiResponse<Map<String, Object>> rosterOptions(Map<String, Object> body) {
		Map<String, Object> request = weekRequest(body);
		if (body.get("min_gain_sec") instanceof Number gain) {
			request.put("min_gain_sec", gain);
		}
		// 주휴 비교(추천안을 긴 근무조로 한 번 더). 빼면 ai-server가 한다. 쉬운 화면은 false로 보내 계산을 줄인다.
		if (body.get("compare_holiday_pay") instanceof Boolean holiday) {
			request.put("compare_holiday_pay", holiday);
		}
		// 미리 계산(RosterWarmService)만 true: ai-server가 낮은 우선순위로 돌려 진짜 계산에 양보한다. 결과는 같다.
		if (Boolean.TRUE.equals(body.get("background"))) {
			request.put("background", true);
		}
		return call("/tools/simulation/roster-options", request, ":options", "추천 근무표 응답을 받지 못했습니다.");
	}

	private ApiResponse<Map<String, Object>> call(String path, Map<String, Object> request, String suffix, String failure) {
		String key = AiServerClient.newRequestKey() + suffix;
		ApiResponse<Map<String, Object>> response = client.post(path, request, key, RESPONSE);
		if (response == null || response.status() == null || response.status() == ResponseStatus.ERROR) {
			throw new AiServerException(failure);
		}
		return response;
	}

	/** 요일별 폼 값(operation_form) → 하루 근무표 조건으로 바꾸고 직원 명단을 붙인다. */
	@SuppressWarnings("unchecked")
	private static Map<String, Object> weekRequest(Map<String, Object> body) {
		if (!(body.get("days") instanceof java.util.List<?> days) || days.isEmpty() || days.size() > 7
				|| !(body.get("workers") instanceof java.util.List<?> workers) || workers.isEmpty() || workers.size() > 20) {
			throw com.solution.common.exception.ApiException.badRequest("INVALID_REQUEST",
					"요일별 조건(1~7일)과 직원 명단(1~20명)을 보내 주세요.");
		}
		java.util.List<Map<String, Object>> rosterDays = new java.util.ArrayList<>();
		LocalDate today = LocalDate.now(SEOUL);
		for (Object item : days) {
			if (!(item instanceof Map<?, ?> raw) || !(raw.get("day") instanceof String day)) {
				throw com.solution.common.exception.ApiException.badRequest("INVALID_REQUEST", "요일(day)을 보내 주세요.");
			}
			Map<String, Object> dayBody = (Map<String, Object>) raw;
			Map<String, Object> roster = OperationInputBuilder.rosterRequest(dayBody,
					dayBody.get("owner_start_time") instanceof String s ? s : null,
					dayBody.get("owner_end_time") instanceof String e ? e : null, today);
			rosterDays.add(Map.of("day", day, "roster", roster));
		}
		Map<String, Object> request = new java.util.LinkedHashMap<>();
		request.put("days", rosterDays);
		request.put("workers", body.get("workers"));
		return request;
	}

	/**
	 * 일주일 근무표: 요일별 근무조(days)와 직원 명단(workers)을 ai-server /tools/simulation/weekly-roster로 넘긴다.
	 * 배정·주 15시간·주휴 계산은 ai-server가 한다. 저장하지 않는다.
	 */
	public ApiResponse<Map<String, Object>> week(Map<String, Object> body) {
		if (!(body.get("days") instanceof java.util.List<?> days) || days.isEmpty() || days.size() > 7
				|| !(body.get("workers") instanceof java.util.List<?> workers) || workers.isEmpty() || workers.size() > 20) {
			throw com.solution.common.exception.ApiException.badRequest("INVALID_REQUEST",
					"요일별 근무조(1~7일)와 직원 명단(1~20명)을 보내 주세요.");
		}
		Map<String, Object> request = new java.util.LinkedHashMap<>();
		request.put("days", body.get("days"));
		request.put("workers", body.get("workers"));
		request.put("weekly_mode", body.getOrDefault("weekly_mode", "COMPARE"));
		String key = AiServerClient.newRequestKey() + ":weekly";
		ApiResponse<Map<String, Object>> response = client.post("/tools/simulation/weekly-roster", request, key, RESPONSE);
		if (response == null || response.status() == null || response.status() == ResponseStatus.ERROR) {
			throw new AiServerException("일주일 근무표 응답을 받지 못했습니다.");
		}
		return response;
	}
}
