package com.solution.operation.service.simulation;

import com.solution.operation.service.OperationResultContract;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import org.springframework.core.ParameterizedTypeReference;
import org.springframework.stereotype.Service;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.operation.dto.simulation.SimulationRequest;
import com.solution.operation.dto.simulation.SimulationResult;
import com.solution.operation.dto.StaffingPlan;
import com.solution.operation.service.labor.SimulationStaffingMapper;

/**
 * 운영 비교 엔진의 실제 HTTP 연결점. 미완성 엔진을 합성 결과로 대체하지 않는다.
 *
 * <p>직원 계약은 choices[].staffing.employees, 기존 검토 계약은 data.staffing으로 구분한다.
 * 실제 사용한 전체 계획만 인정한다. 임의로 요청값을 복사해 응답으로 간주하지 않는다.
 * docs/operation/SIMULATION_HANDOFF.md의 요청·응답 예제를 가영 담당 구현과 함께 검토해야 한다.
 */
@Service
public class FastApiSimulationService implements SimulationService {

	private static final ParameterizedTypeReference<ApiResponse<Map<String, Object>>> RESPONSE =
			new ParameterizedTypeReference<>() { };

	private final AiServerClient client;

	public FastApiSimulationService(AiServerClient client) {
		this.client = client;
	}

	@Override
	public SimulationResult compare(SimulationRequest request, String requestKey) {
		Map<String, Object> body = new LinkedHashMap<>(request.conditions());
		for (String reserved : List.of("choices", "plans", "staffing_schema_version", "request_key")) body.remove(reserved);
		body.put("session_id", request.sessionId());
		body.put("input_version_id", request.inputVersionId());
		body.put("result_id", request.resultId());
		boolean employeeContract = SimulationStaffingMapper.usesEmployees(request.expectedStaffing());
		if (employeeContract) {
			body.put("staffing_schema_version", SimulationStaffingMapper.VERSION);
			body.put("choices", SimulationStaffingMapper.toChoices(request.expectedStaffing()));
			body.put("request_key", requestKey);
		} else {
			body.put("plans", request.expectedStaffing().stream().map(StaffingPlan::asMap).toList());
		}
		ApiResponse<Map<String, Object>> response = client.post(
				"/tools/simulation/compare", body, requestKey, RESPONSE);
		if (response == null || response.status() == null || response.data() == null
				|| response.status() == ResponseStatus.ERROR) {
			throw new AiServerException("운영 시뮬레이션 응답을 받지 못했습니다.");
		}
		List<StaffingPlan> staffing = null;
		if (response.status() == ResponseStatus.OK) {
			Map<String, Object> data = response.data();
			OperationResultContract.require(sameId(data.get("session_id"), request.sessionId()));
			OperationResultContract.require(sameId(data.get("input_version_id"), request.inputVersionId()));
			OperationResultContract.require(sameId(data.get("result_id"), request.resultId()));
			if (employeeContract) {
				OperationResultContract.require(requestKey.equals(data.get("request_key")));
			}
			// 30회 완주·집계가 끝난(complete: true) 응답만 배치를 읽는다. 미완료 응답은 배치가 비어 있을 수 있으므로
			// 여기서 계약 오류로 끊지 않고 호출자가 complete를 보고 400 RESULT_NOT_READY(또는 502)로 정한다.
			if (!Boolean.TRUE.equals(data.get("complete"))) {
				return new SimulationResult(response, null, requestKey);
			}
			if (employeeContract) {
				staffing = SimulationStaffingMapper.fromData(data);
			} else {
				staffing = OperationResultContract.staffing(data.get("staffing")).stream()
						.map(StaffingPlan::fromConfirmedPlan).toList();
			}
		}
		return new SimulationResult(response, staffing, requestKey);
	}

	private static boolean sameId(Object value, long expected) {
		return value instanceof Number number && number.longValue() == expected
				&& number.doubleValue() == expected;
	}
}
