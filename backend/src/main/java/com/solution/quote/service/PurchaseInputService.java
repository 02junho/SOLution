package com.solution.quote.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.fasterxml.jackson.databind.JsonNode;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.quote.dto.PurchaseInputRequest;
import com.solution.session.dto.WorkSessionCreateRequest;
import com.solution.session.dto.WorkSessionEventRequest;
import com.solution.session.service.WorkSessionEventService;
import com.solution.session.service.WorkSessionService;

/**
 * "이 견적으로 구매안 만들기": 견적 정리 결과를 구매 업무의 입력 버전으로 넘긴다. 작성: 신준호 (구매 최적화)
 *
 * <p>흐름: 견적 화면 → Spring(필요량 미리보기·사전·견적 배치 읽기 → 구매 입력으로 묶기) → 구매 업무 생성 →
 * 기존 폼 입력 경로(/events, event_type=form)로 저장. 검증·빈 값 질문·새 버전 규칙은 업무 쪽 것을 그대로 쓴다.
 * 묶기에 실패하면(견적 없는 품목 등) 업무를 만들기 전에 400으로 끝난다.
 */
@Service
public class PurchaseInputService {

	static final String TITLE = "견적으로 준비한 이번 주 매입";
	private static final List<String> CONDITIONS = List.of("planning_days", "budget_krw", "max_delivery_count");

	private final QuoteResourceService resources;
	private final MaterialRequirementService materials;
	private final WorkSessionService sessions;
	private final WorkSessionEventService events;
	private final TransactionTemplate transactions;

	public PurchaseInputService(QuoteResourceService resources, MaterialRequirementService materials,
			WorkSessionService sessions, WorkSessionEventService events, TransactionTemplate transactions) {
		this.resources = resources;
		this.materials = materials;
		this.sessions = sessions;
		this.events = events;
		this.transactions = transactions;
	}

	public ApiResponse<Map<String, Object>> create(String quoteStoreId, UUID preparationId, PurchaseInputRequest request) {
		List<String> batchIds = request.quoteBatchIds().stream().map(String::trim).distinct().toList();
		List<PurchaseInputBuilder.Batch> batches = new ArrayList<>();
		for (String batchId : batchIds) {
			try {
				UUID.fromString(batchId);
			}
			catch (IllegalArgumentException e) {
				throw ApiException.badRequest("견적 분석 묶음 ID 형식이 올바르지 않아요: " + batchId);
			}
			batches.add(new PurchaseInputBuilder.Batch(batchId,
					resources.read(quoteStoreId, "quotes:" + preparationId + ":" + batchId)));
		}
		JsonNode preview = materials.preview(quoteStoreId, preparationId);
		JsonNode dictionary = resources.read(quoteStoreId, "items");

		Map<String, Object> conditions = new LinkedHashMap<>();
		Map<String, Object> given = request.conditions() == null ? Map.of() : request.conditions();
		CONDITIONS.forEach(name -> conditions.put(name, given.get(name)));
		Map<String, Object> source = new LinkedHashMap<>();
		source.put("quote_store_id", quoteStoreId);
		source.put("preparation_id", preparationId.toString());
		source.put("quote_batch_ids", batchIds);
		PurchaseInputBuilder.Built built = PurchaseInputBuilder.build(preview, dictionary, batches, conditions, source);

		// 업무 생성과 첫 입력 저장을 한 트랜잭션으로 묶는다. 저장 검증에서 거절되면 업무도 남지 않는다.
		// (handleEvent 안의 트랜잭션은 이 트랜잭션에 합류한다. 폼 입력은 AI를 부르지 않아 트랜잭션이 길어지지 않는다.)
		Saved result = transactions.execute(status -> {
			long sessionId = sessions.create(new WorkSessionCreateRequest(request.storeId(), "purchase", "form", TITLE))
					.data().sessionId();
			return new Saved(sessionId, events.handleEvent(sessionId, "purchase-input:" + UUID.randomUUID(),
					new WorkSessionEventRequest("form", null, null, built.input(), null, null)));
		});
		Map<String, Object> data = new LinkedHashMap<>(result.response().data());
		data.put("session_id", result.sessionId());
		data.put("excluded_lines", built.excludedLines());
		return new ApiResponse<>(result.response().status(), data, result.response().message());
	}

	private record Saved(long sessionId, ApiResponse<Map<String, Object>> response) {
	}
}
