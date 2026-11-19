package com.solution.operation.service;

import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Optional;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

/** Spring은 결과·진행 단계만 쓴다. execution_log는 조회만 한다. V1 스키마 변경 없음. */
@Repository
public class OperationResultRepository {

	private final JdbcTemplate jdbc;

	public OperationResultRepository(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	public record SessionVersion(long sessionId, long storeId, String featureType, int currentVersion,
			String ownerKey, Long inputVersionId, Integer versionNo, String inputJson,
			OffsetDateTime inputConfirmedAt) {
	}

	public record StoredResult(long resultId, long inputVersionId, long sessionId, int versionNo,
			String featureType, String responseStatus, String detailStatus, String summaryJson,
			String detailJson, OffsetDateTime createdAt, int currentVersion, String ownerKey,
			String confirmedChoiceKey) {
	}

	public record Trace(long logId, long resultId, long inputVersionId, long sessionId, String payloadJson) {
	}

	public Optional<SessionVersion> findSessionVersion(long sessionId, long versionId) {
		return jdbc.query("""
				SELECT s.session_id, s.store_id, s.feature_type, s.current_version, st.owner_key,
				       v.input_version_id, v.version_no, v.input_json::text, v.input_confirmed_at
				FROM work_session s JOIN store st ON st.store_id = s.store_id
				LEFT JOIN work_version v ON v.session_id = s.session_id AND v.input_version_id = ?
				WHERE s.session_id = ? AND s.deleted_at IS NULL
				""", (rs, i) -> new SessionVersion(rs.getLong("session_id"), rs.getLong("store_id"),
				rs.getString("feature_type"), rs.getInt("current_version"), rs.getString("owner_key"),
				(Long) rs.getObject("input_version_id"), (Integer) rs.getObject("version_no"),
				rs.getString("input_json"), rs.getObject("input_confirmed_at", OffsetDateTime.class)),
				versionId, sessionId).stream().findFirst();
	}

	public Optional<StoredResult> findResult(long resultId, boolean includeDetail) {
		return queryResult("r.result_id = ?", includeDetail, resultId);
	}

	public Optional<StoredResult> findByRequestKey(long sessionId, String key) {
		return queryResult("s.session_id = ? AND r.request_key = ?", false, sessionId, key);
	}

	private Optional<StoredResult> queryResult(String where, boolean detail, Object... args) {
		// where·projection은 고정된 내부 문자열만 쓴다. 사용자 값은 모두 바인딩한다.
		String projection = detail ? "r.detail_json::text" : "NULL::text";
		String sql = """
				SELECT r.result_id, v.input_version_id, v.session_id, v.version_no, s.feature_type,
				       r.response_status, r.detail_status, r.summary_json::text,
				       %s AS detail_json, r.created_at, s.current_version, st.owner_key, c.selected_choice_key
				FROM work_result r
				JOIN work_version v ON v.input_version_id = r.input_version_id AND v.session_id = r.session_id
				JOIN work_session s ON s.session_id = v.session_id
				JOIN store st ON st.store_id = s.store_id
				LEFT JOIN work_confirmation c ON c.result_id = r.result_id
				WHERE r.feature_type = 'operation' AND s.feature_type = 'operation'
				  AND r.store_id = s.store_id AND r.version_no = v.version_no AND (%s)
				ORDER BY r.created_at DESC, r.result_id DESC LIMIT 1
				""".formatted(projection, where);
		return jdbc.query(sql, OperationResultRepository::mapResult, args).stream().findFirst();
	}

	private static StoredResult mapResult(ResultSet rs, int index) throws SQLException {
		return new StoredResult(rs.getLong("result_id"), rs.getLong("input_version_id"),
				rs.getLong("session_id"), rs.getInt("version_no"), rs.getString("feature_type"),
				rs.getString("response_status"), rs.getString("detail_status"), rs.getString("summary_json"),
				rs.getString("detail_json"), rs.getObject("created_at", OffsetDateTime.class),
				rs.getInt("current_version"), rs.getString("owner_key"), rs.getString("selected_choice_key"));
	}

	/** 계산 시작·종료·저장을 삭제와 같은 세션 행 잠금으로 직렬화한다. */
	public void lockSession(long sessionId) {
		jdbc.query("SELECT session_id FROM work_session WHERE session_id = ? FOR UPDATE", rs -> { }, sessionId);
	}

	public void startRun(long sessionId) {
		jdbc.update("UPDATE work_session SET active_operation_runs = active_operation_runs + 1 WHERE session_id = ?", sessionId);
	}

	public void finishRun(long sessionId) {
		jdbc.update("UPDATE work_session SET active_operation_runs = active_operation_runs - 1 WHERE session_id = ?", sessionId);
	}

	public void insertResult(StoredResult result, SessionVersion source, String requestKey) {
		jdbc.update("""
				INSERT INTO work_result(result_id, input_version_id, session_id, store_id, version_no,
				 feature_type, request_key, response_status, detail_status, summary_json, detail_json, created_at)
				VALUES (?, ?, ?, ?, ?, 'operation', ?, ?, ?, ?::jsonb, ?::jsonb, ?)
				""", result.resultId(), source.inputVersionId(), source.sessionId(), source.storeId(),
				source.versionNo(), requestKey, result.responseStatus(), result.detailStatus(),
				result.summaryJson(), result.detailJson(), result.createdAt());
	}

	public void markStep(long sessionId, int versionNo, String step) {
		jdbc.update("""
				UPDATE work_session SET step = ?, updated_at = now()
				WHERE session_id = ? AND current_version = ? AND step <> 'saved'
				""", step, sessionId, versionNo);
	}

	public Optional<Trace> findTrace(long resultId, long logId) {
		List<Trace> rows = jdbc.query("""
				SELECT l.log_id, l.result_id, l.input_version_id, l.session_id, l.payload_json::text
				FROM execution_log l JOIN work_result r ON r.result_id = l.result_id
				JOIN work_version v ON v.input_version_id = r.input_version_id AND v.session_id = r.session_id
				WHERE l.log_id = ? AND r.result_id = ? AND r.feature_type = 'operation'
				  AND l.log_type = 'simulation_trace'
				  AND l.input_version_id = v.input_version_id AND l.session_id = v.session_id
				""", (rs, i) -> new Trace(rs.getLong("log_id"), rs.getLong("result_id"),
				rs.getLong("input_version_id"), rs.getLong("session_id"), rs.getString("payload_json")),
				logId, resultId);
		return rows.stream().findFirst();
	}
}
