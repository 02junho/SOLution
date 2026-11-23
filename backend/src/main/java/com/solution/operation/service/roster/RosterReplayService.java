package com.solution.operation.service.roster;

import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.operation.service.OperationResultService;
import com.solution.operation.service.input.OperationInputBuilder;

/**
 * 저장한 추천 근무표의 "줄 서는 모습". 결과 번호 + 요일 + 근무표만 받고, 계산 조건과 근무조는 저장된 결과에서 꺼낸다
 * (화면이 조건을 보내지 않으니 바꿔 보낼 수 없다). ai-server가 같은 첫 반복을 한 번 다시 돌려 재생 기록을 돌려준다.
 * 저장하지 않는다(DB 변경 없음). 결과 주인 확인은 결과 조회와 같은 규칙을 쓴다.
 */
@Service
public class RosterReplayService {

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };
	private static final ZoneId SEOUL = ZoneId.of("Asia/Seoul");
	private static final Set<String> DAYS = Set.of("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN");
	private static final Set<String> CHOICES = Set.of("SAVE", "RECOMMENDED", "ROOMY");

	private final OperationResultService results;
	private final AiServerClient client;

	public RosterReplayService(OperationResultService results, AiServerClient client) {
		this.results = results;
		this.client = client;
	}

	@SuppressWarnings("unchecked")
	public ApiResponse<Map<String, Object>> replay(long resultId, String day, String choice) {
		if (!DAYS.contains(day) || !CHOICES.contains(choice)) {
			throw ApiException.badRequest("INVALID_REQUEST", "요일(MON~SUN)과 근무표(SAVE·RECOMMENDED·ROOMY)를 보내 주세요.");
		}
		Map<String, Object> stored = results.result(resultId, "detail").data();
		Map<String, Object> summary = stored.get("summary") instanceof Map<?, ?> s ? (Map<String, Object>) s : Map.of();
		Map<String, Object> detail = stored.get("detail") instanceof Map<?, ?> d ? (Map<String, Object>) d : null;
		if (!"ROSTER_OPTIONS".equals(summary.get("result_kind")) || detail == null) {
			throw ApiException.badRequest("NOT_ROSTER_RESULT", "추천 근무표 결과만 줄 서는 모습을 볼 수 있어요.");
		}
		Map<String, Object> dayBody = find(list(map(detail.get("request")).get("days")), "day", day);
		Map<String, Object> option = find(list(detail.get("choices")), "choice_key", choice);
		Object shifts = map(map(option.get("days")).get(day)).get("shifts");
		if (dayBody.isEmpty() || !(shifts instanceof List<?> rows) || rows.isEmpty()) {
			throw ApiException.notFound("ROSTER_DAY_NOT_FOUND", "이 요일 근무표가 없어요.");
		}
		Map<String, Object> roster = OperationInputBuilder.rosterRequest(dayBody,
				dayBody.get("owner_start_time") instanceof String start ? start : null,
				dayBody.get("owner_end_time") instanceof String end ? end : null, LocalDate.now(SEOUL));
		Map<String, Object> body = new LinkedHashMap<>();
		body.put("roster", roster);
		body.put("shifts", shifts);
		body.put("choice_key", choice);
		ApiResponse<Map<String, Object>> response = client.post("/tools/simulation/roster-replay", body,
				AiServerClient.newRequestKey() + ":replay", RESPONSE);
		if (response == null || response.status() == null || response.status() == ResponseStatus.ERROR) {
			throw new AiServerException("줄 서는 모습을 만들지 못했습니다.");
		}
		return response;
	}

	@SuppressWarnings("unchecked")
	private static Map<String, Object> map(Object value) {
		return value instanceof Map<?, ?> m ? (Map<String, Object>) m : Map.of();
	}

	private static List<?> list(Object value) {
		return value instanceof List<?> l ? l : List.of();
	}

	private static Map<String, Object> find(List<?> rows, String key, String value) {
		return rows.stream().map(RosterReplayService::map).filter(row -> value.equals(row.get(key))).findFirst().orElse(Map.of());
	}
}
