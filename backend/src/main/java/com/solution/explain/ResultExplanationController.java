package com.solution.explain;

import java.util.Map;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;

/**
 * 결과 설명 요청. 작성: 신준호
 *
 * <p>응답 data는 FastAPI /agent/explain 그대로: {detail_status, source: llm|template, explanation:
 * {headline, per_choice[], warnings_echo[], caveats[]}}. LLM을 쓸 수 없으면 template 설명이 온다.
 */
@RestController
public class ResultExplanationController {

	private final ResultExplanationService service;

	public ResultExplanationController(ResultExplanationService service) {
		this.service = service;
	}

	@PostMapping("/api/v1/work-results/{resultId}/explanation")
	public ApiResponse<Map<String, Object>> explain(@PathVariable long resultId,
			@RequestHeader(value = "X-Request-Key", required = false) String requestKey) {
		return service.explain(resultId, requestKey);
	}
}
