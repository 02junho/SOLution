package com.solution.session.service;

import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 공통 흐름이 읽고 쓰는 테이블 접근 (work_session·work_version·session_message, 매장은 읽기만).
 * 작성: 엄혜원 (공통 흐름·오케스트레이션 도메인)
 *
 * <p>매입 도메인(PurchaseRepository)과 같은 방식으로 JdbcTemplate + SQL을 직접 쓴다. 표는 Flyway가 만든다.
 */
@Repository
public class SessionRepository {

	private final JdbcTemplate jdbcTemplate;

	public SessionRepository(JdbcTemplate jdbcTemplate) {
		this.jdbcTemplate = jdbcTemplate;
	}

	/** 매장의 소유자 식별값. 매장이 없으면 빈 값(→ 서비스가 404). 소유권 비교는 서비스에서 한다. */
	public Optional<String> findStoreOwnerKey(long storeId) {
		List<String> rows = jdbcTemplate.query("SELECT owner_key FROM store WHERE store_id = ?",
				(rs, i) -> rs.getString("owner_key"), storeId);
		return rows.stream().findFirst();
	}

	/** 새 업무 한 행을 넣는다. PK(session_id)는 서버가 만든 값을 그대로 쓴다(DB 자동 증가 없음). */
	public void insertSession(long sessionId, long storeId, String featureType, String inputMethod, String title,
			int currentVersion, String step, OffsetDateTime createdAt) {
		jdbcTemplate.update("""
				INSERT INTO work_session (session_id, store_id, feature_type, input_method, title,
				                          current_version, step, created_at, updated_at)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
				""", sessionId, storeId, featureType, inputMethod, title, currentVersion, step, createdAt, createdAt);
	}
}
