package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.util.Optional;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.support.TransactionCallback;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.session.dto.ConfirmInputRequest;
import com.solution.session.service.SessionRepository.ConfirmationVersionRow;

class WorkVersionServiceTest {

	private final SessionRepository repository = mock(SessionRepository.class);
	private final TransactionTemplate transactions = mock(TransactionTemplate.class);
	private final WorkVersionService service = new WorkVersionService(repository, new CurrentOwner("owner"), transactions);

	@BeforeEach
	void transaction() {
		doAnswer(call -> {
			TransactionCallback<Object> work = call.getArgument(0);
			return work.doInTransaction(null);
		}).when(transactions).execute(any());
	}

	@Test
	void 다른_매장은_세션을_잠그기_전에_거절한다() {
		given(repository.findConfirmationVersion(1002)).willReturn(Optional.of(row("other", 2)));
		assertThatThrownBy(() -> service.confirmInput(1002, new ConfirmInputRequest(1)))
				.isInstanceOfSatisfying(InputConfirmException.class,
						e -> assertThat(e.getDetailCode()).isEqualTo("VERSION_NOT_FOUND"));
		verify(repository, never()).lockSession(anyLong());
	}

	@Test
	void 잠금_대기_중_권한이_바뀌면_거절한다() {
		given(repository.findConfirmationVersion(1002)).willReturn(Optional.of(row("owner", 2)),
				Optional.of(row("other", 2)));
		assertThatThrownBy(() -> service.confirmInput(1002, null)).isInstanceOf(InputConfirmException.class);
		verify(repository).lockSession(500);
		verify(repository, never()).confirmVersion(anyLong(), anyString());
	}

	@Test
	void 잠금_후_최신_순번으로_검사한다() {
		given(repository.findConfirmationVersion(1002)).willReturn(Optional.of(row("owner", 2)),
				Optional.of(row("owner", 3)));
		assertThatThrownBy(() -> service.confirmInput(1002, null))
				.isInstanceOfSatisfying(InputConfirmException.class,
						e -> assertThat(e.getDetailCode()).isEqualTo("STALE_VERSION"));
		verify(repository, never()).confirmVersion(anyLong(), anyString());
	}

	private ConfirmationVersionRow row(String owner, int current) {
		return new ConfirmationVersionRow(500, 2, current, owner, null, null, "review");
	}
}
