package com.solution.purchase.controller;

import java.util.Map;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import com.solution.common.client.AiServerClient;
import com.solution.common.response.ApiResponse;
import com.solution.purchase.dto.PurchaseRunRequest;
import com.solution.purchase.service.PurchaseService;

import jakarta.validation.Valid;

/** ① 매입 — 구매 최적화. 비교 카드는 계산 실행 응답의 summary만, 거래처별 목록·주문 문구는 상세 조회에서 읽는다. */
@RestController
@RequestMapping("/api/v1/purchase")
public class PurchaseController {

	private final PurchaseService purchaseService;

	public PurchaseController(PurchaseService purchaseService) {
		this.purchaseService = purchaseService;
	}

	/** 사장님이 확인한 최신 입력 버전으로 구매안을 계산해 저장한다. 같은 X-Request-Key로 다시 보내면 다시 계산하지 않는다. */
	@PostMapping("/sessions/{sessionId}/results")
	public ApiResponse<Map<String, Object>> run(@PathVariable long sessionId,
			@Valid @RequestBody PurchaseRunRequest request,
			@RequestHeader(value = AiServerClient.REQUEST_KEY_HEADER, required = false) String requestKey) {
		return purchaseService.run(sessionId, request.inputVersionId(), requestKey);
	}

	/** 구매안 상세 (거래처별 목록 · 주문 문구 · 계산 근거). FastAPI를 다시 부르지 않는다. */
	@GetMapping("/results/{resultId}")
	public ApiResponse<Map<String, Object>> detail(@PathVariable long resultId) {
		return purchaseService.detail(resultId);
	}
}
