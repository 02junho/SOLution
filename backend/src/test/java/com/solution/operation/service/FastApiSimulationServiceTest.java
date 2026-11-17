package com.solution.operation.service;

import com.solution.operation.service.simulation.FastApiSimulationService;

import com.solution.operation.service.simulation.SimulationService;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.core.ParameterizedTypeReference;

import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.response.ApiResponse;
import com.solution.operation.dto.simulation.SimulationRequest;
import com.solution.operation.dto.StaffingPlan;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

@SuppressWarnings("unchecked")
class FastApiSimulationServiceTest {

	@Test
	void sendsConfirmedConditionsAndUsesStaffingReturnedByEngine() throws Exception {
		var client = mock(AiServerClient.class);
		var mapper = JsonMapper.builder().build();
		Map<String, Object> fixture = mapper.readValue(
				Files.readString(Path.of("../data/demo/operation/compare_response.json")),
				new TypeReference<>() { });
		Map<String, Object> data = (Map<String, Object>)fixture.get("data");
		List<StaffingPlan> staffing = OperationResultContract.staffing(data.get("staffing"))
				.stream().map(StaffingPlan::fromConfirmedPlan).toList();
		ArgumentCaptor<Map<String, Object>> body = ArgumentCaptor.forClass(Map.class);
		when(client.post(eq("/tools/simulation/compare"), body.capture(), eq("run:simulation"),
				any(ParameterizedTypeReference.class))).thenReturn(ApiResponse.ok(data));
		var request = new SimulationRequest(520001, 530001, 7001,
				Map.of("repetitions", 30, "random_seed", 42), staffing);
		var result = new FastApiSimulationService(client).compare(request, "run:simulation");
		assertThat(body.getValue()).containsEntry("session_id", 520001L)
				.containsEntry("input_version_id", 530001L).containsKey("plans");
		assertThat(result.staffing()).isEqualTo(staffing);
		data.remove("staffing");
		assertThatThrownBy(() -> new FastApiSimulationService(client).compare(request, "run:simulation"))
				.isInstanceOf(AiServerException.class);
	}

	@Test
	void propagatesMissingInputWithoutInventingStaffingOrStatistics() {
		var client = mock(AiServerClient.class);
		when(client.post(anyString(), any(), anyString(), any(ParameterizedTypeReference.class)))
				.thenReturn(ApiResponse.needsInput(Map.of("missing_fields", List.of()), "조건을 확인해 주세요."));
		var request = new SimulationRequest(1, 2, 3, Map.of(), List.of());
		var result = new FastApiSimulationService(client).compare(request, "key");
		assertThat(result.staffing()).isNull();
		assertThat(result.response().status().getValue()).isEqualTo("needs_input");
	}
    @Test
    void mapsVersionedEmployeeContractAndChecksActualRequestKey() throws Exception {
        var client = mock(AiServerClient.class);
        var mapper = JsonMapper.builder().build();
        Map<String, Object> fixture = mapper.readValue(Files.readString(Path.of("../data/demo/operation/staffing_proposal/compare_response.json")), new TypeReference<>() { });
        Map<String, Object> data = (Map<String, Object>)fixture.get("data");
        var plans = com.solution.operation.service.labor.SimulationStaffingMapper.fromData(data);
        ArgumentCaptor<Map<String, Object>> body = ArgumentCaptor.forClass(Map.class);
        when(client.post(eq("/tools/simulation/compare"), body.capture(), eq("staffing-review:simulation"), any(ParameterizedTypeReference.class)))
                .thenReturn(ApiResponse.ok(data));
        var request = new SimulationRequest(520001, 530001, 7001, Map.of("repetitions", 30), plans);
        var result = new FastApiSimulationService(client).compare(request, "staffing-review:simulation");
        assertThat(body.getValue()).containsKey("choices").doesNotContainKey("plans");
        assertThat(result.staffing()).isEqualTo(plans);
        data.put("request_key", "another-request");
        assertThatThrownBy(() -> new FastApiSimulationService(client).compare(request, "staffing-review:simulation"))
                .isInstanceOf(AiServerException.class);
    }

}
