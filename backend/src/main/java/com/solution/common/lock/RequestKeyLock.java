package com.solution.common.lock;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

/**
 * 같은 요청 키의 계산 결과를 한 번만 저장하기 위한 잠금 (PostgreSQL advisory lock).
 *
 * <p>work_result.request_key에는 UQ가 없다(ERD). 그래서 같은 요청이 동시에 두 번 오면 둘 다 저장될 수 있다.
 * work_result에 쓰는 API(구매·운영 계산 실행)는 저장하는 트랜잭션 안에서 이 잠금을 먼저 걸고,
 * 같은 입력 버전·요청 키의 결과가 이미 있는지 다시 확인한 뒤 없을 때만 저장한다.
 *
 * <pre>{@code
 * transactionTemplate.execute(status -> {
 *     requestKeyLock.lock("operation", inputVersionId, requestKey);
 *     // 다시 확인 → 있으면 그 결과, 없으면 저장
 * });
 * }</pre>
 *
 * <p>잠금은 트랜잭션이 끝나면 저절로 풀린다. 트랜잭션 밖에서 부르면 바로 풀려 의미가 없다.
 * 서로 다른 키의 해시가 겹치면 잠깐 기다릴 뿐 결과는 바뀌지 않는다.
 */
@Component
public class RequestKeyLock {

	private final JdbcTemplate jdbcTemplate;

	public RequestKeyLock(JdbcTemplate jdbcTemplate) {
		this.jdbcTemplate = jdbcTemplate;
	}

	/** feature: purchase · operation. 기능마다 키 공간을 나눈다. */
	public void lock(String feature, long inputVersionId, String requestKey) {
		jdbcTemplate.query("SELECT pg_advisory_xact_lock(hashtext(?))", rs -> {
		}, feature + ":" + inputVersionId + ":" + requestKey);
	}
}
