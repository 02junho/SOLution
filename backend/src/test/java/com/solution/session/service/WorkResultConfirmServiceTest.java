package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.id.IdGenerator;
import com.solution.common.lock.RequestKeyLock;
import com.solution.session.dto.ConfirmResultRequest;
import com.solution.session.service.ConfirmationRepository.Source;
import com.solution.session.service.ConfirmationRepository.Stored;

import tools.jackson.databind.json.JsonMapper;

class WorkResultConfirmServiceTest {

	private final ConfirmationRepository repository = mock(ConfirmationRepository.class);
	private final SessionRepository sessions = mock(SessionRepository.class);
	private final TransactionTemplate transactions = mock(TransactionTemplate.class);
	private final WorkResultConfirmService service = new WorkResultConfirmService(repository, sessions,
			new CurrentOwner("demo-owner"), mock(IdGenerator.class), mock(RequestKeyLock.class),
			JsonMapper.builder().build(), transactions, mock(ConfirmationAudit.class));
	private final ConfirmResultRequest request = new ConfirmResultRequest(1002L, "purchase_1", List.of("VAT_UNKNOWN"));

	@BeforeEach
	void transaction() {
		doAnswer(call -> {
			TransactionCallback<Object> work = call.getArgument(0);
			return work.doInTransaction(null);
		}).when(transactions).execute(any());
	}

	@Test
	void Python_compact_UTF8_JSON의_SHA256_기준값과_동일하다() {
		assertThat(service.fingerprint("demo-owner", 2001, request, List.of("VAT_UNKNOWN")))
				.isEqualTo("60b195e59b7d6f5ee389cfe0949da9e9253ce03384f940e4a151fb2b951181df");
	}

	@Test
	void 경고_ID는_순서와_중복을_정규화한다() {
		assertThat(WorkResultConfirmService.normalize(List.of("VAT_UNKNOWN", "A", "A"))).containsExactly("A", "VAT_UNKNOWN");
		assertThat(WorkResultConfirmService.normalize(null)).isEmpty();
	}

	@Test
	void 다른_매장_결과는_잠금과_멱등_조회보다_먼저_거절한다() {
		given(repository.findSource(2001)).willReturn(Optional.of(source("other", 2)));
		assertThatThrownBy(() -> service.confirm(2001, "key", request))
				.isInstanceOfSatisfying(ResultConfirmException.class, e -> assertThat(e.getDetailCode()).isEqualTo("RESULT_NOT_FOUND"));
		verify(sessions, never()).lockSession(anyLong());
		verify(repository, never()).findByKey(any());
	}

	@Test
	void 잠금_대기_후_권한을_다시_검사한다() {
		given(repository.findSource(2001)).willReturn(Optional.of(source("demo-owner", 2)), Optional.of(source("other", 2)));
		assertThatThrownBy(() -> service.confirm(2001, "key", request)).isInstanceOf(ResultConfirmException.class);
		verify(sessions).lockSession(500);
		verify(repository, never()).findByKey(any());
	}

	@Test
	void 잠금_대기_후_최신_버전으로_검사한다() {
		given(repository.findSource(2001)).willReturn(Optional.of(source("demo-owner", 2)), Optional.of(source("demo-owner", 3)));
		assertThatThrownBy(() -> service.confirm(2001, "key", request))
				.isInstanceOfSatisfying(ResultConfirmException.class, e -> assertThat(e.getDetailCode()).isEqualTo("STALE_VERSION"));
		verify(repository, never()).hasVersionConfirmation(anyLong());
	}

	@Test
	void INSERT의_UNIQUE_경합은_버전중복으로_반환한다() {
		given(repository.findSource(2001)).willReturn(Optional.of(readySource()));
		given(repository.findByKey("key")).willReturn(Optional.empty());
		given(repository.hasVersionConfirmation(1002)).willReturn(false, true);
		assertThatThrownBy(() -> service.confirm(2001, "key", request))
				.isInstanceOfSatisfying(ResultConfirmException.class,
						e -> assertThat(e.getDetailCode()).isEqualTo("VERSION_ALREADY_CONFIRMED"));
		verify(sessions, never()).updateSessionProgress(anyLong(), anyInt(), anyString());
	}

	@Test
	void INSERT_경합에서_같은_키의_다른내용은_키재사용_오류다() {
		given(repository.findSource(2001)).willReturn(Optional.of(readySource()));
		given(repository.findByKey("key")).willReturn(Optional.empty(), Optional.of(stored("different")));
		assertThatThrownBy(() -> service.confirm(2001, "key", request))
				.isInstanceOfSatisfying(ResultConfirmException.class,
						e -> assertThat(e.getDetailCode()).isEqualTo("IDEMPOTENCY_KEY_REUSED"));
	}

	@Test
	void INSERT_경합에서_같은_키의_같은내용은_재전송_응답이다() {
		given(repository.findSource(2001)).willReturn(Optional.of(readySource()));
		String hash = service.fingerprint("demo-owner", 2001, request, List.of("VAT_UNKNOWN"));
		given(repository.findByKey("key")).willReturn(Optional.empty(), Optional.of(stored(hash)));
		assertThat(service.confirm(2001, "key", request).data().isNew()).isFalse();
		verify(sessions, never()).updateSessionProgress(anyLong(), anyInt(), anyString());
	}

	private Source readySource() {
		return new Source(2001, 1002, 500, 10, 2, 2, "purchase", "demo-owner", OffsetDateTime.now(), "ok",
				"{\"choices\":[{\"choice_key\":\"purchase_1\"}],\"warnings\":[{\"warning_id\":\"VAT_UNKNOWN\",\"requires_ack\":true}]}",
				null, "result");
	}

	private Stored stored(String fingerprint) {
		return new Stored(3001, 2001, 1002, 500, 10, 2, "purchase", "purchase_1", "demo-owner", OffsetDateTime.now(), fingerprint);
	}

	private Source source(String owner, int currentVersion) {
		return new Source(2001, 1002, 500, 10, 2, currentVersion, "purchase", owner,
				OffsetDateTime.now(), "ok", "{}", null, "result");
	}
}
