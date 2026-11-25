package com.solution.operation.service.simulation;

import com.solution.operation.dto.simulation.SimulationRequest;
import com.solution.operation.dto.simulation.SimulationResult;

/**
 * 시뮬레이션과 운영 저장을 분리하는 내부 연결점.
 * FastApiSimulationService가 HTTP를 연결하며, 가영 담당 실제 엔진과 인계 계약을 함께 검토한다.
 */
@FunctionalInterface
public interface SimulationService {
	SimulationResult compare(SimulationRequest request, String requestKey);
}
