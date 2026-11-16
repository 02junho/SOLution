package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.times;

import org.mockito.ArgumentCaptor;

import java.time.OffsetDateTime;
import java.util.Map;
import java.util.Optional;
import org.springframework.transaction.support.TransactionCallback;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.client.AiServerClient;
import com.solution.common.client.AiServerException;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.WorkSessionEventRequest;
import com.solution.session.service.SessionRepository.CurrentVersionRow;
import com.solution.session.service.SessionRepository.SessionContextRow;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

class WorkSessionEventServiceTest {

	private SessionRepository repository;
	private AiServerClient aiServerClient;
	private CurrentOwner currentOwner;
	private IdGenerator idGenerator;
	private TransactionTemplate transactionTemplate;
	private WorkSessionEventService service;

	private final ObjectMapper objectMapper = JsonMapper.builder().build();

	@BeforeEach
	void setUp() {
		repository = mock(SessionRepository.class);
		aiServerClient = mock(AiServerClient.class);
		currentOwner = mock(CurrentOwner.class);
		idGenerator = mock(IdGenerator.class);
		transactionTemplate = mock(TransactionTemplate.class);
		// 트랜잭션 목은 안에 넣은 작업을 그대로 실행한다.
		doAnswer(invocation -> {
			TransactionCallback<Object> work = invocation.getArgument(0);
			return work.doInTransaction(null);
		}).when(transactionTemplate).execute(any());

		service = new WorkSessionEventService(repository, aiServerClient, currentOwner, idGenerator, objectMapper,
				transactionTemplate);
	}

	private SessionContextRow ctx(int currentVersion, Long currentVersionId, String owner) {
		return new SessionContextRow(100L, 10L, "purchase", "agent", "제목", currentVersion, currentVersionId,
				null, "input", null, false, OffsetDateTime.now(), OffsetDateTime.now(), owner);
	}

	@Test
	void 폼_첫_입력이면_새_버전을_만들고_입력검토를_돌려준다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(ctx(1, null, "owner-demo")));
		given(repository.findVersion(100L, 1)).willReturn(Optional.empty()); // 아직 입력 버전 없음
		given(idGenerator.next()).willReturn(1000L, 1001L, 1002L);

		WorkSessionEventRequest request = new WorkSessionEventRequest("form", null, null,
				Map.of("budget_krw", 100000), null, null);
		ApiResponse<Map<String, Object>> response = service.handleEvent(100L, "key-1", request);

		assertThat(response.status()).isEqualTo(ResponseStatus.OK);
		assertThat(response.data().get("step")).isEqualTo("review");
		assertThat(response.data().get("version_no")).isEqualTo(1);
		verify(repository).insertVersion(anyLong(), eq(100L), eq(1), anyString(), any(), anyString(), any());
		verify(repository).updateSessionProgress(100L, 1, "review");
	}

	@Test
	void 폼_입력이_이전과_같으면_새_버전을_만들지_않는다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(ctx(1, 500L, "owner-demo")));
		String sameInput = objectMapper.writeValueAsString(Map.of("budget_krw", 100000));
		given(repository.findVersion(100L, 1)).willReturn(Optional.of(new CurrentVersionRow(500L, 1, sameInput)));

		WorkSessionEventRequest request = new WorkSessionEventRequest("form", null, null,
				Map.of("budget_krw", 100000), null, null);
		ApiResponse<Map<String, Object>> response = service.handleEvent(100L, "key-1", request);

		assertThat(response.status()).isEqualTo(ResponseStatus.OK);
		verify(repository, never()).insertVersion(anyLong(), anyLong(), anyInt(), anyString(), any(), anyString(),
				any());
	}

	@Test
	void 폼_입력이_비어있으면_400() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(ctx(1, null, "owner-demo")));

		WorkSessionEventRequest request = new WorkSessionEventRequest("form", null, null, Map.of(), null, null);
		assertThatThrownBy(() -> service.handleEvent(100L, "key-1", request))
				.isInstanceOf(ApiException.class)
				.hasMessage("form 입력이 필요합니다.");
	}

	@Test
	void 대화는_FastAPI를_부르고_미구현이면_예외가_그대로_난다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(ctx(1, 500L, "owner-demo")));
		given(repository.findVersion(100L, 1)).willReturn(Optional.empty());
		given(aiServerClient.post(eq("/agent/interpret"), any(), any(), any()))
				.willThrow(new AiServerException("AI 서버에 연결하지 못했습니다: /agent/interpret"));

		WorkSessionEventRequest request = new WorkSessionEventRequest("message", 1001L, "우유를 2L로 바꿔줘",
				null, null, null);
		assertThatThrownBy(() -> service.handleEvent(100L, "key-1", request))
				.isInstanceOf(AiServerException.class);
	}

	@Test
	void 없는_업무면_404() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(999L)).willReturn(Optional.empty());

		WorkSessionEventRequest request = new WorkSessionEventRequest("form", null, null, Map.of("a", 1), null,
				null);
		assertThatThrownBy(() -> service.handleEvent(999L, "key-1", request))
				.isInstanceOf(ApiException.class)
				.hasMessage("업무를 찾을 수 없습니다.");
	}

	@Test
	void 같은_요청키_재전송이면_처음_응답을_그대로_돌려준다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(ctx(1, null, "owner-demo")));
		given(idGenerator.next()).willReturn(1000L, 1001L, 1002L);
		WorkSessionEventRequest request = new WorkSessionEventRequest("form", null, null,
				Map.of("budget_krw", 100000), null, null);
		ApiResponse<Map<String, Object>> first = service.handleEvent(100L, "key-dup", request);
		ArgumentCaptor<String> metadata = ArgumentCaptor.forClass(String.class);
		verify(repository).insertMessage(anyLong(), eq(100L), eq(1), eq("assistant"), anyString(), metadata.capture(), any());
		given(repository.findEventMetadata(100L, "key-dup")).willReturn(Optional.of(metadata.getValue()));

		assertThat(objectMapper.readTree(objectMapper.writeValueAsString(service.handleEvent(100L, "key-dup", request))))
				.isEqualTo(objectMapper.readTree(objectMapper.writeValueAsString(first)));
		verify(repository, times(1)).insertVersion(anyLong(), anyLong(), anyInt(), anyString(), any(), anyString(), any());
	}
}
