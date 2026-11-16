package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.id.IdGenerator;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.WorkSessionContextResponse;
import com.solution.session.dto.WorkSessionCreateRequest;
import com.solution.session.dto.WorkSessionListResponse;
import com.solution.session.dto.WorkSessionResponse;
import com.solution.session.service.SessionRepository.SessionContextRow;
import com.solution.session.service.SessionRepository.SessionSummaryRow;

class WorkSessionServiceTest {

	private SessionRepository repository;
	private CurrentOwner currentOwner;
	private IdGenerator idGenerator;
	private WorkSessionService service;

	@BeforeEach
	void setUp() {
		repository = mock(SessionRepository.class);
		currentOwner = mock(CurrentOwner.class);
		idGenerator = mock(IdGenerator.class);
		service = new WorkSessionService(repository, currentOwner, idGenerator);
	}

	@Test
	void 내_매장이면_세션을_만들고_제목_없으면_기본값을_넣는다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findStoreOwnerKey(10L)).willReturn(Optional.of("owner-demo"));
		given(idGenerator.next()).willReturn(100L);

		ApiResponse<WorkSessionResponse> response = service.create(
				new WorkSessionCreateRequest(10L, "purchase", "agent", null));

		WorkSessionResponse data = response.data();
		assertThat(data.sessionId()).isEqualTo(100L);
		assertThat(data.currentVersion()).isEqualTo(1);
		assertThat(data.step()).isEqualTo("input");
		assertThat(data.title()).isEqualTo("이번 주 매입 준비");
		verify(repository).insertSession(anyLong(), anyLong(), anyString(), anyString(), anyString(), anyInt(),
				anyString(), any());
	}

	@Test
	void 남의_매장이면_404이고_저장하지_않는다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findStoreOwnerKey(10L)).willReturn(Optional.of("someone-else"));

		assertThatThrownBy(() -> service.create(new WorkSessionCreateRequest(10L, "purchase", "agent", null)))
				.isInstanceOf(ApiException.class)
				.hasMessage("매장을 찾을 수 없습니다.");
		verify(repository, never()).insertSession(anyLong(), anyLong(), anyString(), anyString(), anyString(),
				anyInt(), anyString(), any());
	}

	@Test
	void 없는_매장이면_404() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findStoreOwnerKey(999L)).willReturn(Optional.empty());

		assertThatThrownBy(() -> service.create(new WorkSessionCreateRequest(999L, "operation", "form", null)))
				.isInstanceOf(ApiException.class)
				.hasMessage("매장을 찾을 수 없습니다.");
	}

	@Test
	void 내_업무면_문맥을_돌려주고_입력확인_시각이_있으면_input_confirmed_true() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(new SessionContextRow(
				100L, 10L, "purchase", "agent", "제목", 2, 1002L,
				OffsetDateTime.parse("2026-11-13T10:15:00+09:00"), "review", 2001L, true,
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"),
				OffsetDateTime.parse("2026-11-13T10:20:00+09:00"), "owner-demo")));

		WorkSessionContextResponse data = service.getContext(100L).data();
		assertThat(data.inputConfirmed()).isTrue();
		assertThat(data.currentVersionId()).isEqualTo(1002L);
		assertThat(data.latestResultId()).isEqualTo(2001L);
		assertThat(data.hasConfirmation()).isTrue();
	}

	@Test
	void 입력확인_시각이_없으면_input_confirmed_false() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(new SessionContextRow(
				100L, 10L, "purchase", "agent", "제목", 1, null, null, "input", null, false,
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"),
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"), "owner-demo")));

		assertThat(service.getContext(100L).data().inputConfirmed()).isFalse();
	}

	@Test
	void 남의_업무_문맥은_404() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(100L)).willReturn(Optional.of(new SessionContextRow(
				100L, 10L, "purchase", "agent", "제목", 1, null, null, "input", null, false,
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"),
				OffsetDateTime.parse("2026-11-13T10:00:00+09:00"), "someone-else")));

		assertThatThrownBy(() -> service.getContext(100L))
				.isInstanceOf(ApiException.class)
				.hasMessage("업무를 찾을 수 없습니다.");
	}

	@Test
	void 없는_업무_문맥은_404() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessionContext(999L)).willReturn(Optional.empty());

		assertThatThrownBy(() -> service.getContext(999L))
				.isInstanceOf(ApiException.class)
				.hasMessage("업무를 찾을 수 없습니다.");
	}

	@Test
	void 목록은_size보다_한_건_더_조회해_다음_커서를_만든다() {
		given(currentOwner.key()).willReturn("owner-demo");
		// size=1 → limit+1=2 조회. 두 건이 오면 다음 페이지가 있다는 뜻.
		given(repository.findSessions("owner-demo", null, null, null, 2)).willReturn(List.of(
				new SessionSummaryRow(100L, "purchase", "A", "result", 2,
						OffsetDateTime.parse("2026-11-13T10:12:00+09:00")),
				new SessionSummaryRow(99L, "purchase", "B", "input", 1,
						OffsetDateTime.parse("2026-11-13T09:00:00+09:00"))));

		WorkSessionListResponse data = service.list(null, null, 1).data();
		assertThat(data.items()).hasSize(1);
		assertThat(data.items().get(0).sessionId()).isEqualTo(100L);
		assertThat(data.nextCursor()).isNotNull();
	}

	@Test
	void 결과가_size_이하면_다음_커서가_없다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessions("owner-demo", null, null, null, 21)).willReturn(List.of(
				new SessionSummaryRow(100L, "purchase", "A", "result", 2,
						OffsetDateTime.parse("2026-11-13T10:12:00+09:00"))));

		WorkSessionListResponse data = service.list(null, null, 20).data();
		assertThat(data.items()).hasSize(1);
		assertThat(data.nextCursor()).isNull();
	}

	@Test
	void 목록_feature_type이_범위밖이면_400() {
		assertThatThrownBy(() -> service.list("delivery", null, 20))
				.isInstanceOf(ApiException.class);
	}

	@Test
	void 잘못된_커서는_400() {
		assertThatThrownBy(() -> service.list(null, "!!not-base64!!", 20))
				.isInstanceOf(ApiException.class);
	}
	@Test
	void 기본_크기와_최대_크기를_적용한다() {
		given(currentOwner.key()).willReturn("owner-demo");
		given(repository.findSessions("owner-demo", null, null, null, 21)).willReturn(List.of());
		given(repository.findSessions("owner-demo", null, null, null, 101)).willReturn(List.of());

		assertThat(service.list(null, null, 0).data().items()).isEmpty();
		assertThat(service.list(null, null, Integer.MAX_VALUE).data().items()).isEmpty();
		verify(repository).findSessions("owner-demo", null, null, null, 21);
		verify(repository).findSessions("owner-demo", null, null, null, 101);
	}

}
