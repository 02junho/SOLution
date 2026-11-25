package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import org.junit.jupiter.api.Test;

import com.solution.common.auth.CurrentOwner;
import com.solution.session.dto.WorkConfirmationListResponse.Item;
import com.solution.session.dto.WorkConfirmationDetailResponse;

class WorkConfirmationServiceTest {

	private final ConfirmationListRepository repository = mock(ConfirmationListRepository.class);
	private final WorkConfirmationService service = new WorkConfirmationService(repository, new CurrentOwner("owner"));

	@Test
	void 내_소유자와_필터를_전달하고_마지막_반환행으로_다음커서를_만든다() {
		var time = OffsetDateTime.parse("2026-11-13T10:00:00.000001Z");
		given(repository.find("owner", "purchase", 500L, null, null, 2)).willReturn(List.of(
				new Item(3002, 500, "purchase", "purchase_1", 2, true, time),
				new Item(3001, 500, "purchase", "purchase_1", 1, false, time)));
		var first = service.list("purchase", 500L, null, 1).data();
		assertThat(first.items()).hasSize(1);
		assertThat(first.nextCursor()).isNotBlank();
		given(repository.find("owner", "purchase", 500L, time, 3002L, 2)).willReturn(List.of());
		assertThat(service.list("purchase", 500L, first.nextCursor(), 1).data().items()).isEmpty();
		verify(repository).find("owner", "purchase", 500L, time, 3002L, 2);
	}

	@Test
	void 페이지_크기만큼이면_다음커서는_없다() {
		given(repository.find("owner", null, null, null, null, 2)).willReturn(List.of(
				new Item(3001, 500, "purchase", "purchase_1", 1, true, OffsetDateTime.now())));
		assertThat(service.list(null, null, null, 1).data().nextCursor()).isNull();
	}
	@Test
	void 상세_조회는_서버_사용자로_범위를_제한하고_보존본을_변형하지_않는다() {
		var row = new WorkConfirmationDetailResponse(3001, 2001, 1002, 500, "purchase", "purchase_1", "owner",
				OffsetDateTime.now(), true, "[\"VAT_UNKNOWN\"]", "{\"total_krw\":120400}");
		given(repository.findDetail(3001, "owner")).willReturn(Optional.of(row));
		assertThat(service.getDetail(3001).data()).isSameAs(row);
		verify(repository).findDetail(3001, "owner");
	}

	@Test
	void 없는_확정과_권한_없는_확정은_같은_예외로_처리한다() {
		given(repository.findDetail(9999, "owner")).willReturn(Optional.empty());
		assertThatThrownBy(() -> service.getDetail(9999)).isInstanceOf(ConfirmationNotFoundException.class);
	}

}
