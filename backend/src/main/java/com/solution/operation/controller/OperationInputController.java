package com.solution.operation.controller;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import jakarta.validation.Valid;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.operation.dto.input.OperationInputDraftRequest;
import com.solution.operation.service.input.OperationInputBuilder;

/**
 * 운영 폼 값 → 운영 계산 입력 초안. 저장하지 않는다.
 * 화면은 받은 input을 공통 업무 API(POST /api/v1/work-sessions/{id}/events, event_type=form)로 저장하고
 * 입력 확인 → 운영 계산 실행(POST /api/v1/operation/sessions/{id}/results)으로 이어 간다.
 */
@RestController
@RequestMapping("/api/v1/operation")
public class OperationInputController {

	@PostMapping("/input-drafts")
	public ApiResponse<Map<String, Object>> draft(@Valid @RequestBody OperationInputDraftRequest form) {
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("input", OperationInputBuilder.build(form));
		data.put("plan_descriptions", List.of(
				Map.of("choice_key", "CURRENT", "title", "현재 방식",
						"description", "2명이 07~19시 일해요. 주문·전달 1명, 제조 1명이 각자 맡은 일만 해요."),
				Map.of("choice_key", "ALT_A", "title", "서로 돕기",
						"description", "사람과 근무시간은 그대로, 바쁜 시간에만 서로의 일을 도와요."),
				Map.of("choice_key", "ALT_C", "title", "한 명 추가",
						"description", "바쁜 시간에 제조를 맡고 주문도 돕는 직원 1명을 더해요.")));
		return ApiResponse.ok(data);
	}
}
