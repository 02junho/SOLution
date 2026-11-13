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

	/** 업무 문맥 복원용 한 줄. 현재 입력 버전·입력 확인 시각·최근 결과 ID·확정 유무·매장 소유자까지 함께 읽는다. */
	public record SessionContextRow(long sessionId, long storeId, String featureType, String inputMethod,
			String title, int currentVersion, Long currentVersionId, OffsetDateTime inputConfirmedAt, String step,
			Long latestResultId, boolean hasConfirmation, OffsetDateTime createdAt, OffsetDateTime updatedAt,
			String ownerKey) {
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

	/**
	 * 업무 하나의 복원 문맥을 읽는다. 현재 버전 번호에 해당하는 입력 버전을 LEFT JOIN으로 붙이고(아직 없으면 null),
	 * 최근 결과 ID와 확정 유무는 실제 테이블에서 바로 계산한다(목록용 복제값을 믿지 않음).
	 */
	public Optional<SessionContextRow> findSessionContext(long sessionId) {
		List<SessionContextRow> rows = jdbcTemplate.query("""
				SELECT s.session_id, s.store_id, s.feature_type, s.input_method, s.title,
				       s.current_version, s.step, s.created_at, s.updated_at, st.owner_key,
				       v.input_version_id AS current_version_id, v.input_confirmed_at,
				       (SELECT r.result_id FROM work_result r
				         WHERE r.input_version_id = v.input_version_id
				         ORDER BY r.created_at DESC, r.result_id DESC
				         LIMIT 1) AS latest_result_id,
				       EXISTS (SELECT 1 FROM work_confirmation c
				         JOIN work_version cv ON cv.input_version_id = c.input_version_id
				         WHERE cv.session_id = s.session_id) AS has_confirmation
				FROM work_session s
				JOIN store st ON st.store_id = s.store_id
				LEFT JOIN work_version v ON v.session_id = s.session_id AND v.version_no = s.current_version
				WHERE s.session_id = ?
				""", (rs, i) -> new SessionContextRow(
				rs.getLong("session_id"),
				rs.getLong("store_id"),
				rs.getString("feature_type"),
				rs.getString("input_method"),
				rs.getString("title"),
				rs.getInt("current_version"),
				(Long) rs.getObject("current_version_id"),
				rs.getObject("input_confirmed_at", OffsetDateTime.class),
				rs.getString("step"),
				(Long) rs.getObject("latest_result_id"),
				rs.getBoolean("has_confirmation"),
				rs.getObject("created_at", OffsetDateTime.class),
				rs.getObject("updated_at", OffsetDateTime.class),
				rs.getString("owner_key")),
				sessionId);
		return rows.stream().findFirst();
	}
}
