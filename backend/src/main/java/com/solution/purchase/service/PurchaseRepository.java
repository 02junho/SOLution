package com.solution.purchase.service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/**
 * 구매 기능이 읽고 쓰는 테이블 접근. 업무·입력 버전·매장은 읽기만 하고, 쓰는 것은 work_result와 work_session.step뿐이다.
 *
 * <p>공통 엔티티(work_session 등)는 흐름 담당과 겹치지 않게 아직 만들지 않고 SQL로 직접 읽는다.
 */
@Repository
public class PurchaseRepository {

	private final JdbcTemplate jdbcTemplate;

	public PurchaseRepository(JdbcTemplate jdbcTemplate) {
		this.jdbcTemplate = jdbcTemplate;
	}

	/** 업무와, 그 업무에 속한 입력 버전 하나. 입력 버전이 이 업무 것이 아니면 version 쪽 값이 null이다. */
	public record SessionVersion(long sessionId, long storeId, String featureType, int currentVersion,
			String ownerKey, Long inputVersionId, Integer versionNo, String inputJson,
			OffsetDateTime inputConfirmedAt) {
	}

	/** 저장된 계산 결과와, 확정 가능 여부를 판단할 값들. 매장·업무는 복제값이 아니라 입력 버전을 따라가 읽는다. */
	public record StoredResult(long resultId, long inputVersionId, long sessionId, int versionNo,
			String featureType, String responseStatus, String detailStatus, String summaryJson,
			String detailJson, OffsetDateTime createdAt, int currentVersion, String ownerKey,
			String confirmedChoiceKey) {
	}

	public Optional<SessionVersion> findSessionVersion(long sessionId, long inputVersionId) {
		List<SessionVersion> rows = jdbcTemplate.query("""
				SELECT s.session_id, s.store_id, s.feature_type, s.current_version, st.owner_key,
				       v.input_version_id, v.version_no, v.input_json::text AS input_json, v.input_confirmed_at
				FROM work_session s
				JOIN store st ON st.store_id = s.store_id
				LEFT JOIN work_version v ON v.session_id = s.session_id AND v.input_version_id = ?
				WHERE s.session_id = ?
				""", (rs, i) -> new SessionVersion(
				rs.getLong("session_id"),
				rs.getLong("store_id"),
				rs.getString("feature_type"),
				rs.getInt("current_version"),
				rs.getString("owner_key"),
				(Long) rs.getObject("input_version_id"),
				(Integer) rs.getObject("version_no"),
				rs.getString("input_json"),
				rs.getObject("input_confirmed_at", OffsetDateTime.class)),
				inputVersionId, sessionId);
		return rows.stream().findFirst();
	}

	/** 같은 입력 버전·같은 요청 키로 이미 저장한 결과 (재전송이면 다시 계산하지 않는다). */
	public Optional<StoredResult> findByRequestKey(long inputVersionId, String requestKey) {
		return queryResult("r.input_version_id = ? AND r.request_key = ?", inputVersionId, requestKey);
	}

	public Optional<StoredResult> findResult(long resultId) {
		return queryResult("r.result_id = ?", resultId);
	}

	private Optional<StoredResult> queryResult(String where, Object... args) {
		List<StoredResult> rows = jdbcTemplate.query("""
				SELECT r.result_id, r.input_version_id, v.session_id, v.version_no, s.feature_type,
				       r.response_status, r.detail_status, r.summary_json::text AS summary_json,
				       r.detail_json::text AS detail_json, r.created_at, s.current_version, st.owner_key,
				       c.selected_choice_key
				FROM work_result r
				JOIN work_version v ON v.input_version_id = r.input_version_id
				JOIN work_session s ON s.session_id = v.session_id
				JOIN store st ON st.store_id = s.store_id
				LEFT JOIN work_confirmation c ON c.result_id = r.result_id
				WHERE r.feature_type = 'purchase' AND """ + where + """

				ORDER BY r.created_at DESC
				LIMIT 1
				""", PurchaseRepository::mapResult, args);
		return rows.stream().findFirst();
	}

	private static StoredResult mapResult(ResultSet rs, int i) throws SQLException {
		return new StoredResult(
				rs.getLong("result_id"),
				rs.getLong("input_version_id"),
				rs.getLong("session_id"),
				rs.getInt("version_no"),
				rs.getString("feature_type"),
				rs.getString("response_status"),
				rs.getString("detail_status"),
				rs.getString("summary_json"),
				rs.getString("detail_json"),
				rs.getObject("created_at", OffsetDateTime.class),
				rs.getInt("current_version"),
				rs.getString("owner_key"),
				rs.getString("selected_choice_key"));
	}

	public void insertResult(long resultId, SessionVersion source, String requestKey, String responseStatus,
			String detailStatus, String summaryJson, String detailJson, OffsetDateTime createdAt) {
		jdbcTemplate.update("""
				INSERT INTO work_result (result_id, input_version_id, session_id, store_id, version_no, feature_type,
				                         request_key, response_status, detail_status, summary_json, detail_json, created_at)
				VALUES (?, ?, ?, ?, ?, 'purchase', ?, ?, ?, ?::jsonb, ?::jsonb, ?)
				""", resultId, source.inputVersionId(), source.sessionId(), source.storeId(), source.versionNo(),
				requestKey, responseStatus, detailStatus, summaryJson, detailJson, createdAt);
	}

	public void markSessionResult(long sessionId) {
		jdbcTemplate.update("UPDATE work_session SET step = 'result', updated_at = now() WHERE session_id = ?",
				sessionId);
	}
}
