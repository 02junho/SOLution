package com.solution.session.service;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;

import java.sql.SQLException;
import java.time.OffsetDateTime;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.dao.DataAccessResourceFailureException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.id.IdGenerator;
import com.solution.session.service.ConfirmationRepository.Source;

@ExtendWith(OutputCaptureExtension.class)
class ConfirmationAuditTest {

	@Test
	void 감사로그_실패는_호출을_중단하지_않고_예외_클래스만_기록한다(CapturedOutput output) {
		JdbcTemplate jdbc = mock(JdbcTemplate.class);
		doThrow(new DataAccessResourceFailureException("private-db-wrapper", new SQLException("private-db-data")))
				.when(jdbc).update(anyString(), any(Object[].class));
		var audit = new ConfirmationAudit(jdbc, mock(IdGenerator.class),
				new TransactionTemplate(mock(PlatformTransactionManager.class)));
		Source source = new Source(2001, 1002, 500, 10, 2, 2, "purchase", "owner",
				OffsetDateTime.now(), "ok", "{}", null, "saved");
		assertThatCode(() -> audit.record(source, "success", "CONFIRMED", System.nanoTime())).doesNotThrowAnyException();
		assertThat(output.getAll()).contains("확정 감사 기록 실패", DataAccessResourceFailureException.class.getName(), SQLException.class.getName())
				.doesNotContain("private-db-wrapper", "private-db-data", "Caused by:");
	}
}
