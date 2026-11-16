package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.BDDMockito.given;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.Test;

import com.solution.common.auth.CurrentOwner;
import com.solution.session.service.SessionRepository.MessageRow;

import tools.jackson.databind.json.JsonMapper;

class WorkMessageServiceTest {

	private final SessionRepository repository = mock(SessionRepository.class);
	private final WorkMessageService service = new WorkMessageService(repository, new CurrentOwner("owner"), JsonMapper.builder().build());

	@Test
	void 권한이_없으면_메시지를_조회하지_않는다() {
		given(repository.findSessionOwnerKey(500)).willReturn(Optional.of("other"));
		assertThatThrownBy(() -> service.list(500, "invalid", 0)).isInstanceOf(MessageHistoryException.class);
		verify(repository, never()).findMessages(anyLong(), anyString(), any(), anyInt());
	}

	@Test
	void 다음페이지_판단용_한줄을_추가로_읽고_메타데이터를_객체로_변환한다() {
		given(repository.findSessionOwnerKey(500)).willReturn(Optional.of("owner"));
		var time = OffsetDateTime.now();
		given(repository.findMessages(500, "owner", 10L, 2)).willReturn(List.of(
				new MessageRow(30, "assistant", "질문", null, "{\"question_id\":\"q_1\"}", time),
				new MessageRow(50, "user", "답변", 1, null, time)));
		var data = service.list(500, "10", 1).data();
		assertThat(data.items()).hasSize(1);
		assertThat(data.nextCursor()).isEqualTo("30");
		assertThat(data.items().getFirst().metadataJson()).isEqualTo(Map.of("question_id", "q_1"));
	}
}
