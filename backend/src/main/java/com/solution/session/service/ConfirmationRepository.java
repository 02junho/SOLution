package com.solution.session.service;

import java.time.OffsetDateTime;
import java.util.Optional;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

@Repository
public class ConfirmationRepository {

	private final JdbcTemplate jdbc;

	public ConfirmationRepository(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	public record Source(long resultId, long inputVersionId, long sessionId, long storeId, int versionNo,
			int currentVersion, String featureType, String ownerKey, OffsetDateTime inputConfirmedAt,
			String responseStatus, String summaryJson, String detailJson, String step) {
	}

	public record Stored(long confirmationId, long resultId, long inputVersionId, long sessionId, long storeId,
			int versionNo, String featureType, String selectedChoiceKey, String confirmedBy,
			OffsetDateTime confirmedAt, String fingerprint) {
	}

	/** result의 조회용 복제 필드 대신 실제 버전→업무→매장 경로로 읽는다. */
	public Optional<Source> findSource(long resultId) {
		return jdbc.query("""
				SELECT r.result_id, v.input_version_id, v.session_id, s.store_id, v.version_no,
				       s.current_version, s.feature_type, st.owner_key, v.input_confirmed_at,
				       r.response_status, r.summary_json::text, r.detail_json::text, s.step
				FROM work_result r JOIN work_version v ON v.input_version_id = r.input_version_id
				JOIN work_session s ON s.session_id = v.session_id
				JOIN store st ON st.store_id = s.store_id WHERE r.result_id = ?
				""", (rs, i) -> new Source(rs.getLong("result_id"), rs.getLong("input_version_id"),
					rs.getLong("session_id"), rs.getLong("store_id"), rs.getInt("version_no"),
					rs.getInt("current_version"), rs.getString("feature_type"), rs.getString("owner_key"),
					rs.getObject("input_confirmed_at", OffsetDateTime.class), rs.getString("response_status"),
					rs.getString("summary_json"), rs.getString("detail_json"), rs.getString("step")), resultId)
				.stream().findFirst();
	}

	public Optional<Stored> findByKey(String key) {
		return jdbc.query("SELECT * FROM work_confirmation WHERE confirm_request_key = ?", (rs, i) ->
				new Stored(rs.getLong("confirmation_id"), rs.getLong("result_id"), rs.getLong("input_version_id"),
					rs.getLong("session_id"), rs.getLong("store_id"), rs.getInt("version_no"),
					rs.getString("feature_type"), rs.getString("selected_choice_key"), rs.getString("confirmed_by"),
					rs.getObject("confirmed_at", OffsetDateTime.class), rs.getString("request_fingerprint")), key)
				.stream().findFirst();
	}

	public boolean hasVersionConfirmation(long versionId) {
		return Boolean.TRUE.equals(jdbc.queryForObject(
				"SELECT EXISTS (SELECT 1 FROM work_confirmation WHERE input_version_id = ?)", Boolean.class, versionId));
	}

	public void insert(long id, Source source, String choice, String actor, String key, String fingerprint,
			String acknowledgedJson, String snapshotJson) {
		jdbc.update("""
				INSERT INTO work_confirmation (confirmation_id, result_id, input_version_id, session_id, store_id,
				    version_no, feature_type, selected_choice_key, confirmed_by, confirm_request_key,
				    request_fingerprint, acknowledged_warnings_json, selected_snapshot_json)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::jsonb, ?::jsonb)
				""", id, source.resultId(), source.inputVersionId(), source.sessionId(), source.storeId(),
				source.versionNo(), source.featureType(), choice, actor, key, fingerprint, acknowledgedJson, snapshotJson);
	}
}
