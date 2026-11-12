package com.solution.session.controller;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkSessionCreateRequest;
import com.solution.session.dto.WorkSessionResponse;
import com.solution.session.service.WorkSessionService;

import jakarta.validation.Valid;

/**
 * 공통 흐름 — 업무(세션) 시작·조회. 화면은 이 API만 부르고, 계산·AI 호출은 뒤 단계에서 한다.
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 */
@RestController
@RequestMapping("/api/v1/work-sessions")
public class WorkSessionController {

	private final WorkSessionService workSessionService;

	public WorkSessionController(WorkSessionService workSessionService) {
		this.workSessionService = workSessionService;
	}

	/** 매입·운영 업무 한 건을 시작한다. 최초 AI 호출보다 먼저 work_session을 만든다(URQ-FLW-001·002·007). */
	@PostMapping
	public ApiResponse<WorkSessionResponse> create(@Valid @RequestBody WorkSessionCreateRequest request) {
		return workSessionService.create(request);
	}
}
