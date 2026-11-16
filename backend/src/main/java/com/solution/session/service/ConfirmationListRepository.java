package com.solution.session.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;

import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;

import com.solution.session.dto.WorkConfirmationListResponse.Item;

@Repository
public class ConfirmationListRepository {

	private final JdbcTemplate jdbc;

	public ConfirmationListRepository(JdbcTemplate jdbc) {
		this.jdbc = jdbc;
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
}
