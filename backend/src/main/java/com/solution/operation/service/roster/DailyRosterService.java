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
 * 추천 근무표 계산을 ai-server에 부탁한다(운영 2번). 요일별 폼 값 → 하루 근무표 조건으로 바꿔 /tools/simulation/roster-options로 넘긴다.
 * 저장은 RosterResultService가 한다. 개발 확인용 미리보기(하루·일주일 근무표)는 실험실과 함께 뺐다.
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

	/**
	 * 추천 근무표 3안(아끼는/추천/여유): 요일별 폼 값 + 사장님 근무 + 직원 명단.
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
		// 진행 상황 키(계산 작업의 요청 키). ai-server가 끝난 요일을 이 키로 모아 두고, 상태 조회 때 progress로 꺼낸다.
		if (body.get("progress_key") instanceof String progressKey && !progressKey.isBlank() && progressKey.length() <= 111) {
			request.put("progress_key", progressKey);
		}
		return call("/tools/simulation/roster-options", request, ":options", "추천 근무표 응답을 받지 못했습니다.");
	}

	/**
	 * 계산 중인 추천 근무표의 진행 상황(끝난 요일 수와 요일별 추천안 요약). 화면이 끝난 요일부터 먼저 보여 준다.
	 * 진행 표시는 덤이라 ai-server에 못 닿으면 null(상태 조회는 그대로 RUNNING).
	 */
	public Map<String, Object> rosterProgress(String progressKey) {
		try {
			String path = "/tools/simulation/roster-options/progress?key="
					+ java.net.URLEncoder.encode(progressKey, java.nio.charset.StandardCharsets.UTF_8);
			ApiResponse<Map<String, Object>> response = client.get(path, RESPONSE);
			return response == null ? null : response.data();
		} catch (RuntimeException unreachable) {
			return null;
		}
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
}
