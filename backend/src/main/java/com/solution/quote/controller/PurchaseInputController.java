package com.solution.quote.controller;

import java.util.Map;
import java.util.UUID;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.response.ApiResponse;
import com.solution.quote.dto.PurchaseInputRequest;
import com.solution.quote.service.PurchaseInputService;

import jakarta.validation.Valid;

/**
 * 견적 정리 → 구매 업무 연결. 작성: 신준호 (구매 최적화)
 *
 * <p>응답은 업무 입력(/events)과 같은 모양이다: ok면 input_version_id·step=review,
 * 빈 값이 있으면 needs_input(missing_fields·question_id·draft_input). 어느 쪽이든 session_id로 업무 화면을 연다.
 */
@RestController
@RequestMapping("/api/v1/stores/{storeId}/purchase-preparations/{id}")
public class PurchaseInputController {

	private final PurchaseInputService service;

	public PurchaseInputController(PurchaseInputService service) {
		this.service = service;
	}

	@PostMapping("/purchase-input")
	public ApiResponse<Map<String, Object>> create(@PathVariable String storeId, @PathVariable UUID id,
			@Valid @RequestBody PurchaseInputRequest request) {
		return service.create(storeId, id, request);
	}
}
