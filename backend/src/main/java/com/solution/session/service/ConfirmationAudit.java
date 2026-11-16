package com.solution.session.service;

import java.util.UUID;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.core.NestedExceptionUtils;
import org.springframework.stereotype.Component;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.id.IdGenerator;
import com.solution.session.service.ConfirmationRepository.Source;

/** 확정 트랜잭션과 분리한 best-effort 감사 기록. 원문·사용자 요청 키·금액은 기록하지 않는다. */
@Component
public class ConfirmationAudit {

	private static final Logger log = LoggerFactory.getLogger(ConfirmationAudit.class);
	private final JdbcTemplate jdbc;
	private final IdGenerator ids;
	private final TransactionTemplate transactions;

	public ConfirmationAudit(JdbcTemplate jdbc, IdGenerator ids, TransactionTemplate transactions) {
		this.jdbc = jdbc;
		this.ids = ids;
		this.transactions = new TransactionTemplate(transactions.getTransactionManager());
		this.transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
	}

	public void record(Source source, String status, String code, long started) {
		if (source == null) {
			// 소속을 확인하지 못한 결과는 FK와 권한 경계를 위해 상태·코드만 애플리케이션에 남긴다.
			log.info("확정 요청 판정: status={}, detail_code={}", status, code);
			return;
		}
		try {
			transactions.executeWithoutResult(tx -> jdbc.update("""
					INSERT INTO execution_log (log_id, session_id, input_version_id, log_type, request_key,
					    result_id, name, status, latency_ms, payload_json)
					VALUES (?, ?, ?, 'tool', ?, ?, 'confirm', ?, ?, jsonb_build_object('detail_code', ?::text, 'policy_version', 'v1'))
					""", ids.next(), source.sessionId(), source.inputVersionId(), UUID.randomUUID().toString(),
					source.resultId(), status, Math.max(0, (System.nanoTime() - started) / 1_000_000), code));
		}
		catch (RuntimeException e) {
			// SQL 예외 메시지에는 데이터 원문이 섞일 수 있으므로 예외 자체는 출력하지 않는다.
			log.warn("확정 감사 기록 실패: exception_class={}, cause_class={}", e.getClass().getName(),
					NestedExceptionUtils.getMostSpecificCause(e).getClass().getName());
		}
	}
}
