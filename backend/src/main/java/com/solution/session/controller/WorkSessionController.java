package com.solution.session.controller;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkSessionContextResponse;
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

	/** 중단했던 업무를 다시 열 때 현재 문맥(입력 버전·단계·최근 결과/확정 유무)을 복원한다(URQ-FLW-007·HW-F01). */
	@GetMapping("/{sessionId}")
	public ApiResponse<WorkSessionContextResponse> get(@PathVariable String sessionId) {
		long parsedSessionId;
		try {
			parsedSessionId = Long.parseLong(sessionId);
		}
		catch (NumberFormatException e) {
			// 경로 변환 오류가 공통 예외 처리기의 500으로 넘어가지 않도록 요청 오류로 바꾼다.
			throw ApiException.badRequest("업무 번호는 정수 범위의 숫자여야 합니다.");
		}
		return workSessionService.getContext(parsedSessionId);
	}
}
