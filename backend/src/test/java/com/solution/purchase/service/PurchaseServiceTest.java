package com.solution.purchase.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.ArgumentMatchers.isNull;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpStatus;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.purchase.service.PurchaseRepository.SessionVersion;
import com.solution.purchase.service.PurchaseRepository.StoredResult;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

class PurchaseServiceTest {

	private static final String OWNER = "demo-owner";
	private static final OffsetDateTime CONFIRMED = OffsetDateTime.parse("2026-11-13T09:00:00+09:00");
	private static final String INPUT_JSON = """
			{"planning_days": 7, "budget_krw": 200000, "max_delivery_count": 2, "items": [], "suppliers": [], "quotes": []}
			""";

	private final ObjectMapper objectMapper = JsonMapper.builder().build();
	private PurchaseRepository repository;
	private AiServerClient aiServerClient;
	private PurchaseService service;

	@BeforeEach
	void setUp() {
		repository = mock(PurchaseRepository.class);
		aiServerClient = mock(AiServerClient.class);
		service = new PurchaseService(repository, aiServerClient, new CurrentOwner(OWNER), new IdGenerator(),
				objectMapper, new TransactionTemplate(mock(PlatformTransactionManager.class)));
	}

	private static SessionVersion source(String featureType, String owner, int currentVersion, Integer versionNo,
			OffsetDateTime confirmedAt) {
		return new SessionVersion(100, 1, featureType, currentVersion, owner, versionNo == null ? null : 1001L,
				versionNo, INPUT_JSON, confirmedAt);
	}

	private void givenSource(SessionVersion source) {
		given(repository.findSessionVersion(100, 1001)).willReturn(Optional.of(source));
	}

	@SuppressWarnings("unchecked")
	private void givenTool(ApiResponse<Map<String, Object>> response) {
		given(aiServerClient.post(eq(PurchaseService.TOOL_PATH), any(), anyString(),
				any(ParameterizedTypeReference.class))).willReturn(response);
	}

	private static Map<String, Object> okData() {
		return Map.of(
				"detail_status", "OPTIMAL",
				"summary", Map.of("choices", List.of(Map.of("choice_key", "purchase_1", "total_krw", 120400))),
				"detail", Map.of("buy_needs", List.of(Map.of("item_id", "beans", "buy_need", 2200))));
	}

	@Test
	@SuppressWarnings("unchecked")
	void 확인한_최신_입력으로_계산하고_요약과_상세를_나눠_저장한다() {
		givenSource(source("purchase", OWNER, 1, 1, CONFIRMED));
		given(repository.findByRequestKey(1001, "key-1")).willReturn(Optional.empty());
		givenTool(ApiResponse.ok(okData()));

		ApiResponse<Map<String, Object>> response = service.run(100, 1001, "key-1");

		ArgumentCaptor<Object> body = ArgumentCaptor.forClass(Object.class);
		verify(aiServerClient).post(eq(PurchaseService.TOOL_PATH), body.capture(), eq("key-1"),
				any(ParameterizedTypeReference.class));
		assertThat((Map<String, Object>) body.getValue())
				.containsEntry("store_id", 1L)
				.containsEntry("session_id", 100L)
				.containsEntry("input_version_id", 1001L)
				.containsEntry("budget_krw", 200000);

		ArgumentCaptor<String> summary = ArgumentCaptor.forClass(String.class);
		ArgumentCaptor<String> detail = ArgumentCaptor.forClass(String.class);
		verify(repository).insertResult(anyLong(), any(), eq("key-1"), eq("ok"), eq("OPTIMAL"),
				summary.capture(), detail.capture(), any());
		assertThat(summary.getValue()).contains("purchase_1").doesNotContain("buy_needs");
		assertThat(detail.getValue()).contains("buy_needs");
		verify(repository).markSessionResult(100);

		assertThat(response.status()).isEqualTo(ResponseStatus.OK);
		assertThat(response.data())
				.containsKeys("result_id", "created_at")
				.containsEntry("session_id", 100L)
				.containsEntry("input_version_id", 1001L)
				.containsEntry("version_no", 1)
				.containsEntry("detail_status", "OPTIMAL")
				.doesNotContainKey("detail");
		assertThat((Map<String, Object>) response.data().get("summary")).containsKey("choices");
	}

	@Test
	void 요청키가_없으면_새로_만들어_넘긴다() {
		givenSource(source("purchase", OWNER, 1, 1, CONFIRMED));
		given(repository.findByRequestKey(eq(1001L), anyString())).willReturn(Optional.empty());
		givenTool(ApiResponse.ok(okData()));

		service.run(100, 1001, null);

		verify(repository).insertResult(anyLong(), any(), anyString(), eq("ok"), any(), any(), any(), any());
	}

	@Test
	void 같은_요청키로_다시_오면_다시_계산하지_않는다() {
		givenSource(source("purchase", OWNER, 1, 1, CONFIRMED));
		given(repository.findByRequestKey(1001, "key-1")).willReturn(Optional.of(new StoredResult(
				2001, 1001, 100, 1, "purchase", "ok", "OPTIMAL", "{\"choices\": []}", "{}", CONFIRMED, 1, OWNER,
				null)));

		ApiResponse<Map<String, Object>> response = service.run(100, 1001, "key-1");

		verify(aiServerClient, never()).post(anyString(), any(), anyString(), any(ParameterizedTypeReference.class));
		verify(repository, never()).insertResult(anyLong(), any(), anyString(), anyString(), any(), any(), any(),
				any());
		assertThat(response.data()).containsEntry("result_id", 2001L);
	}

	@Test
	void 정보_부족은_저장하고_질문과_빠진_칸을_그대로_돌려준다() {
		givenSource(source("purchase", OWNER, 1, 1, CONFIRMED));
		given(repository.findByRequestKey(1001, "key-1")).willReturn(Optional.empty());
		givenTool(ApiResponse.needsInput(Map.of(
				"detail_status", "NEEDS_INPUT",
				"missing_fields", List.of(Map.of("path", "items[1].usable_inventory", "label", "우유 재고"))),
				"우유 재고가 지금 얼마나 있나요?"));

		ApiResponse<Map<String, Object>> response = service.run(100, 1001, "key-1");

		verify(repository).insertResult(anyLong(), any(), eq("key-1"), eq("needs_input"), eq("NEEDS_INPUT"),
				any(), isNull(), any());
		verify(repository, never()).markSessionResult(anyLong());
		assertThat(response.status()).isEqualTo(ResponseStatus.NEEDS_INPUT);
		assertThat(response.message()).isEqualTo("우유 재고가 지금 얼마나 있나요?");
		assertThat(response.data())
				.containsKeys("result_id", "missing_fields")
				.containsEntry("input_version_id", 1001L)
				.containsEntry("detail_status", "NEEDS_INPUT")
				.doesNotContainKey("message");
	}

	@Test
	void 정보_부족_결과를_다시_읽어도_같은_문구를_돌려준다() {
		givenSource(source("purchase", OWNER, 1, 1, CONFIRMED));
		given(repository.findByRequestKey(1001, "key-1")).willReturn(Optional.of(new StoredResult(
				2002, 1001, 100, 1, "purchase", "infeasible", "INFEASIBLE",
				"{\"detail_status\": \"INFEASIBLE\", \"violations\": [], \"message\": \"예산이 부족해요.\"}", null,
				CONFIRMED, 1, OWNER, null)));

		ApiResponse<Map<String, Object>> response = service.run(100, 1001, "key-1");

		assertThat(response.status()).isEqualTo(ResponseStatus.INFEASIBLE);
		assertThat(response.message()).isEqualTo("예산이 부족해요.");
		assertThat(response.data()).containsKey("violations").doesNotContainKey("message");
	}

	@Test
	void 업무가_없거나_매입이_아니거나_다른_매장이면_404() {
		given(repository.findSessionVersion(100, 1001)).willReturn(Optional.empty());
		assertNotFound();

		givenSource(source("operation", OWNER, 1, 1, CONFIRMED));
		assertNotFound();

		givenSource(source("purchase", "someone-else", 1, 1, CONFIRMED));
		assertNotFound();

		givenSource(source("purchase", OWNER, 1, null, null));
		assertNotFound();
	}

	private void assertNotFound() {
		assertThatThrownBy(() -> service.run(100, 1001, "key-1"))
				.isInstanceOf(ApiException.class)
				.hasMessage(PurchaseService.SESSION_NOT_FOUND)
				.extracting("status").isEqualTo(HttpStatus.NOT_FOUND);
	}

	@Test
	void 최신_버전이_아니면_400() {
		givenSource(source("purchase", OWNER, 2, 1, CONFIRMED));

		assertThatThrownBy(() -> service.run(100, 1001, "key-1"))
				.isInstanceOf(ApiException.class)
				.hasMessage(PurchaseService.NOT_LATEST)
				.extracting("status").isEqualTo(HttpStatus.BAD_REQUEST);
	}

	@Test
	void 입력_확인_전이면_400() {
		givenSource(source("purchase", OWNER, 1, 1, null));

		assertThatThrownBy(() -> service.run(100, 1001, "key-1"))
				.isInstanceOf(ApiException.class)
				.hasMessage(PurchaseService.NOT_CONFIRMED)
				.extracting("status").isEqualTo(HttpStatus.BAD_REQUEST);
	}

	@Test
	void AI_서버가_결과를_주지_않으면_저장하지_않고_오류() {
		givenSource(source("purchase", OWNER, 1, 1, CONFIRMED));
		given(repository.findByRequestKey(1001, "key-1")).willReturn(Optional.empty());
		givenTool(ApiResponse.error("서버 오류가 발생했습니다."));

		assertThatThrownBy(() -> service.run(100, 1001, "key-1")).isInstanceOf(AiServerException.class);
		verify(repository, never()).insertResult(anyLong(), any(), anyString(), anyString(), any(), any(), any(),
				any());
	}

	@Test
	@SuppressWarnings("unchecked")
	void 상세는_저장된_요약과_상세에_확정_가능_여부를_붙인다() {
		given(repository.findResult(2001)).willReturn(Optional.of(new StoredResult(
				2001, 1001, 100, 1, "purchase", "ok", "OPTIMAL", "{\"choices\": []}",
				"{\"buy_needs\": [{\"item_id\": \"beans\", \"buy_need\": 2200}]}", CONFIRMED, 2, OWNER,
				"purchase_1")));

		ApiResponse<Map<String, Object>> response = service.detail(2001);

		assertThat(response.status()).isEqualTo(ResponseStatus.OK);
		assertThat(response.data())
				.containsEntry("result_id", 2001L)
				.containsEntry("response_status", "ok")
				.containsEntry("is_latest_version", false)
				.containsEntry("confirmed_choice_key", "purchase_1");
		assertThat((Map<String, Object>) response.data().get("detail")).containsKey("buy_needs");
		verify(aiServerClient, never()).post(anyString(), any(), anyString(), any(ParameterizedTypeReference.class));
	}

	@Test
	void 다른_매장의_결과는_404() {
		given(repository.findResult(2001)).willReturn(Optional.of(new StoredResult(
				2001, 1001, 100, 1, "purchase", "ok", "OPTIMAL", "{}", "{}", CONFIRMED, 1, "someone-else", null)));

		assertThatThrownBy(() -> service.detail(2001))
				.isInstanceOf(ApiException.class)
				.hasMessage(PurchaseService.RESULT_NOT_FOUND);
	}
}
