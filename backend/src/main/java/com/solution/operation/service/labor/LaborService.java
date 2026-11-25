package com.solution.operation.service.labor;

import com.solution.operation.service.OperationResultContract;

import static com.solution.operation.service.OperationResultContract.map;
import static com.solution.operation.service.OperationResultContract.require;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;

import com.solution.operation.dto.labor.LaborRequest;
import com.solution.operation.dto.labor.LaborResult;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;

/** 5번: 확인한 근무 조건으로 배치표 → 비용 도구를 연결한다. Python이 숫자를 계산한다. */
@Service
public class LaborService {

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };
	private final AiServerClient client;

	public LaborService(AiServerClient client) {
		this.client = client;
	}

	public ApiResponse<Map<String, Object>> calculate(LaborRequest request, String key) {
        Map<String, Object> input = request.confirmedInput();
        long sessionId = request.sessionId(), versionId = request.inputVersionId();
		Map<String, Object> labor = map(input.get("labor"));
		Map<String, Object> body = new LinkedHashMap<>();
		copy(labor, body, "workers", "plans", "auto_break", "avoid_break_windows", "timezone", "rule_policy_version");
		body.put("session_id", sessionId);
		body.put("input_version_id", versionId);
		body.put("business_date", input.get("business_date"));
		ApiResponse<Map<String, Object>> schedule = call("/tools/labor/schedule", body, key + ":schedule");
		if (schedule.status() != ResponseStatus.OK) {
			return schedule;
		}
		checkContext(schedule.data(), sessionId, versionId);
		List<Map<String, Object>> costPlans = new ArrayList<>();
		for (Map<String, Object> plan : OperationResultContract.plans(schedule.data())) {
			require(plan.get("schedule") instanceof List<?>);
			costPlans.add(Map.of("choice_key", plan.get("choice_key"), "shifts", plan.get("schedule")));
		}
		require(OperationResultContract.staffing(costPlans).equals(OperationResultContract.staffing(labor.get("plans"))));
		Map<String, Object> costBody = new LinkedHashMap<>();
		copy(labor, costBody, "workers", "cost_options", "weekly_context", "insurance_context", "monthly_projection");
		copy(input, costBody, "business_date", "wage_year", "assumptions_version");
		costBody.put("session_id", sessionId);
		costBody.put("input_version_id", versionId);
		costBody.put("plans", costPlans);
		ApiResponse<Map<String, Object>> cost = call("/tools/labor/cost", costBody, key + ":cost");
		if (cost.status() != ResponseStatus.OK) {
			return cost;
		}
		checkContext(cost.data(), sessionId, versionId);
		return ApiResponse.ok(new LaborResult(schedule.data(), cost.data()).asMap());
	}

    private static void checkContext(Map<String, Object> data, long sessionId, long versionId) {
        require(OperationResultContract.number(data.get("session_id")) == sessionId);
        require(OperationResultContract.number(data.get("input_version_id")) == versionId);
    }

	private ApiResponse<Map<String, Object>> call(String path, Map<String, Object> body, String key) {
		ApiResponse<Map<String, Object>> result = client.post(path, body, key, RESPONSE);
		if (result == null || result.status() == null || result.status() == ResponseStatus.ERROR || result.data() == null) {
			throw new AiServerException("인건비·배치표 계산 결과를 받지 못했습니다: " + path);
		}
		return result;
	}

	private static void copy(Map<String, Object> from, Map<String, Object> to, String... keys) {
		for (String key : keys) {
			if (from.containsKey(key)) {
				to.put(key, from.get(key));
			}
		}
	}
}
