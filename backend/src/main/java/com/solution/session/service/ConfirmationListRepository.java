package com.solution.session.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import com.solution.session.dto.WorkConfirmationListResponse.Item;
import com.solution.session.dto.WorkConfirmationDetailResponse;

@Repository
public class ConfirmationListRepository {

	private final JdbcTemplate jdbc;

	public ConfirmationListRepository(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
	}

	/** 소유권은 실제 입력 버전→업무→매장으로 확인한다. 호출자는 해당 세션 행을 잠근다. */
	public int delete(long confirmationId, String ownerKey) {
		jdbc.update("""
                INSERT INTO retired_confirmation_key SELECT confirm_request_key, result_id FROM work_confirmation WHERE confirmation_id=?
                ON CONFLICT DO NOTHING
                """, confirmationId);
		return jdbc.update("""
				DELETE FROM work_confirmation c USING work_version v, work_session s, store st
				WHERE c.confirmation_id = ? AND v.input_version_id = c.input_version_id
				  AND s.session_id = v.session_id AND st.store_id = s.store_id AND st.owner_key = ?
				""", confirmationId, ownerKey);
	}

	/** 현재 조건의 마지막 저장 기록을 삭제했을 때만 비교 단계로 돌아간다. */
	public void restoreResultStep(long sessionId, long inputVersionId) {
		jdbc.update("""
				UPDATE work_session s SET step = CASE WHEN active_operation_runs > 0 THEN 'running' ELSE 'result' END,
				updated_at = now()
				WHERE s.session_id = ? AND s.step = 'saved'
				  AND EXISTS (SELECT 1 FROM work_version v WHERE v.input_version_id = ?
				    AND v.session_id = s.session_id AND v.version_no = s.current_version)
				  AND NOT EXISTS (SELECT 1 FROM work_confirmation c JOIN work_version v ON v.input_version_id = c.input_version_id
				    WHERE v.session_id = s.session_id AND v.version_no = s.current_version)
				""", sessionId, inputVersionId);
	}

	/** 확정의 조회용 복제 필드 대신 입력 버전의 실제 업무·매장을 기준으로 권한과 최신성을 판정한다. */
	public List<Item> find(String ownerKey, String featureType, Long sessionId,
			OffsetDateTime cursorAt, Long cursorId, int limit) {
		StringBuilder sql = new StringBuilder("""
				SELECT c.confirmation_id, v.session_id, s.feature_type, c.selected_choice_key, v.version_no,
				       (v.version_no = s.current_version) AS is_current_version, c.confirmed_at
				FROM work_confirmation c
				JOIN work_version v ON v.input_version_id = c.input_version_id
				JOIN work_session s ON s.session_id = v.session_id
				JOIN store st ON st.store_id = s.store_id
				WHERE st.owner_key = ?
				""");
		List<Object> args = new ArrayList<>();
		args.add(ownerKey);
		if (featureType != null) {
			sql.append(" AND s.feature_type = ?");
			args.add(featureType);
		}
		if (sessionId != null) {
			sql.append(" AND v.session_id = ?");
			args.add(sessionId);
		}
		if (cursorAt != null && cursorId != null) {
			sql.append(" AND (c.confirmed_at, c.confirmation_id) < (?, ?)");
			args.add(cursorAt);
			args.add(cursorId);
		}
		sql.append(" ORDER BY c.confirmed_at DESC, c.confirmation_id DESC LIMIT ?");
		args.add(limit);
		return jdbc.query(sql.toString(), (rs, i) -> new Item(rs.getLong("confirmation_id"), rs.getLong("session_id"),
				rs.getString("feature_type"), rs.getString("selected_choice_key"), rs.getInt("version_no"),
				rs.getBoolean("is_current_version"), rs.getObject("confirmed_at", OffsetDateTime.class)), args.toArray());
	}
	/** JSONB 보존본을 읽고, 권한은 복제 store_id 대신 실제 소속으로 확인한다. */
	public Optional<WorkConfirmationDetailResponse> findDetail(long confirmationId, String ownerKey) {
		return jdbc.query("""
				SELECT c.confirmation_id, c.result_id, c.input_version_id, v.session_id, s.feature_type,
				       c.selected_choice_key, c.confirmed_by, c.confirmed_at,
				       (v.version_no = s.current_version) AS is_current_version,
				       c.acknowledged_warnings_json::text, c.selected_snapshot_json::text
				FROM work_confirmation c
				JOIN work_version v ON v.input_version_id = c.input_version_id
				JOIN work_session s ON s.session_id = v.session_id
				JOIN store st ON st.store_id = s.store_id
				WHERE c.confirmation_id = ? AND st.owner_key = ?
				""", (rs, i) -> new WorkConfirmationDetailResponse(rs.getLong("confirmation_id"), rs.getLong("result_id"),
					rs.getLong("input_version_id"), rs.getLong("session_id"), rs.getString("feature_type"),
					rs.getString("selected_choice_key"), rs.getString("confirmed_by"),
					rs.getObject("confirmed_at", OffsetDateTime.class), rs.getBoolean("is_current_version"),
					rs.getString("acknowledged_warnings_json"), rs.getString("selected_snapshot_json")), confirmationId, ownerKey)
				.stream().findFirst();
	}

}
