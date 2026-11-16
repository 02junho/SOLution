package com.solution.session.service;

import java.time.OffsetDateTime;
import java.util.ArrayList;
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

	/** 업무 목록 한 줄. 화면 카드에 필요한 요약만 담는다. */
	public record SessionSummaryRow(long sessionId, String featureType, String title, String step,
			int currentVersion, OffsetDateTime updatedAt) {
	}

	/** 한 입력 버전의 식별자·순번·입력 스냅샷(JSON 문자열). 변경 여부 비교에 쓴다. */
	public record CurrentVersionRow(long inputVersionId, int versionNo, String inputJson) {
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

	/**
	 * 내 매장의 업무를 최신순으로 읽는다(ix_session_store_feature 정렬에 맞춤).
	 * 커서가 있으면 (updated_at, session_id)가 그보다 뒤(더 오래된)인 행만 가져와 다음 페이지를 만든다.
	 * 값은 모두 ?로 넘겨 SQL 주입을 막는다.
	 */
	public List<SessionSummaryRow> findSessions(String ownerKey, String featureType,
			OffsetDateTime cursorUpdatedAt, Long cursorSessionId, int limit) {
		StringBuilder sql = new StringBuilder("""
				SELECT s.session_id, s.feature_type, s.title, s.step, s.current_version, s.updated_at
				FROM work_session s
				JOIN store st ON st.store_id = s.store_id
				WHERE st.owner_key = ?
				""");
		List<Object> args = new ArrayList<>();
		args.add(ownerKey);
		if (featureType != null) {
			sql.append(" AND s.feature_type = ?\n");
			args.add(featureType);
		}
		if (cursorUpdatedAt != null && cursorSessionId != null) {
			sql.append(" AND (s.updated_at < ? OR (s.updated_at = ? AND s.session_id < ?))\n");
			args.add(cursorUpdatedAt);
			args.add(cursorUpdatedAt);
			args.add(cursorSessionId);
		}
		sql.append(" ORDER BY s.updated_at DESC, s.session_id DESC\n LIMIT ?");
		args.add(limit);

		return jdbcTemplate.query(sql.toString(), (rs, i) -> new SessionSummaryRow(
				rs.getLong("session_id"),
				rs.getString("feature_type"),
				rs.getString("title"),
				rs.getString("step"),
				rs.getInt("current_version"),
				rs.getObject("updated_at", OffsetDateTime.class)),
				args.toArray());
	}

	// ===== events(대화·폼·질문답변) 처리용 =====

	/** 업무의 한 입력 버전(순번으로)을 읽는다. 없으면 빈 값(아직 입력 버전이 없는 세션). */
	public Optional<CurrentVersionRow> findVersion(long sessionId, int versionNo) {
		List<CurrentVersionRow> rows = jdbcTemplate.query("""
				SELECT input_version_id, version_no, input_json::text AS input_json
				FROM work_version WHERE session_id = ? AND version_no = ?
				""", (rs, i) -> new CurrentVersionRow(
				rs.getLong("input_version_id"), rs.getInt("version_no"), rs.getString("input_json")),
				sessionId, versionNo);
		return rows.stream().findFirst();
	}

	/** 새 입력 버전 한 행을 넣는다. 확인자·확인시각은 NULL(미확인)로 시작한다(URQ-FLW-005). */
	public void insertVersion(long inputVersionId, long sessionId, int versionNo, String schemaVersion,
			String rawRequest, String inputJson, OffsetDateTime createdAt) {
		jdbcTemplate.update("""
				INSERT INTO work_version (input_version_id, session_id, version_no, schema_version, raw_request,
				                          input_json, input_confirmed_by, input_confirmed_at, created_at)
				VALUES (?, ?, ?, ?, ?, ?::jsonb, NULL, NULL, ?)
				""", inputVersionId, sessionId, versionNo, schemaVersion, rawRequest, inputJson, createdAt);
	}

	/** 현재 입력 버전 번호와 진행 단계를 갱신한다(updated_at은 DB now()로). */
	public void updateSessionProgress(long sessionId, int currentVersion, String step) {
		jdbcTemplate.update(
				"UPDATE work_session SET current_version = ?, step = ?, updated_at = now() WHERE session_id = ?",
				currentVersion, step, sessionId);
	}

	/** 대화 한 줄을 넣는다(사용자·AI 메시지). version_no는 입력 전 대화면 NULL일 수 있다. */
	public void insertMessage(long messageId, long sessionId, Integer versionNo, String role, String content,
			String metadataJson, OffsetDateTime createdAt) {
		jdbcTemplate.update("""
				INSERT INTO session_message (message_id, session_id, version_no, role, content, metadata_json, created_at)
				VALUES (?, ?, ?, ?, ?, ?::jsonb, ?)
				""", messageId, sessionId, versionNo, role, content, metadataJson, createdAt);
	}

	/** 같은 세션의 입력 변경과 요청키 확인을 한 트랜잭션 안에서 직렬화한다. */
	public void lockSession(long sessionId) {
		jdbcTemplate.query("SELECT session_id FROM work_session WHERE session_id = ? FOR UPDATE",
				rs -> {}, sessionId);
	}

	/** 재전송 시 현재 상태가 아니라 처음 저장한 이벤트 응답을 그대로 반환한다. */
	public Optional<String> findEventMetadata(long sessionId, String requestKey) {
		return jdbcTemplate.query("""
				SELECT metadata_json::text FROM session_message
				WHERE session_id = ? AND role = 'assistant' AND metadata_json->>'request_key' = ?
				ORDER BY message_id DESC LIMIT 1
				""", (rs, i) -> rs.getString(1), sessionId, requestKey).stream().findFirst();
	}

	/** 질문 ID는 해당 세션에서 서버가 발급·저장한 질문만 인정한다. */
	public Optional<String> findQuestionMetadata(long sessionId, String questionId) {
		return jdbcTemplate.query("""
				SELECT metadata_json::text FROM (
				    SELECT metadata_json FROM session_message
				    WHERE session_id = ? AND role = 'assistant' AND metadata_json->>'question_id' IS NOT NULL
				    ORDER BY message_id DESC LIMIT 1
				) latest WHERE metadata_json->>'question_id' = ?
				""", (rs, i) -> rs.getString(1), sessionId, questionId).stream().findFirst();
	}

	public void markQuestionAnswered(long sessionId, String questionId) {
		jdbcTemplate.update("""
				UPDATE session_message SET metadata_json = metadata_json || '{"answered":true}'::jsonb
				WHERE session_id = ? AND role = 'assistant' AND metadata_json->>'question_id' = ?
				""", sessionId, questionId);
	}

	/** 입력 확인은 버전의 실제 소속을 따라 권한과 최신 순번을 조회한다. */
	public record ConfirmationVersionRow(long sessionId, int versionNo, int currentVersion,
			String ownerKey, String inputConfirmedBy, OffsetDateTime inputConfirmedAt, String step) {
	}

	public Optional<ConfirmationVersionRow> findConfirmationVersion(long versionId) {
		return jdbcTemplate.query("""
				SELECT v.session_id, v.version_no, s.current_version, st.owner_key,
				       v.input_confirmed_by, v.input_confirmed_at, s.step
				FROM work_version v
				JOIN work_session s ON s.session_id = v.session_id
				JOIN store st ON st.store_id = s.store_id
				WHERE v.input_version_id = ?
				""", (rs, i) -> new ConfirmationVersionRow(rs.getLong("session_id"), rs.getInt("version_no"),
					rs.getInt("current_version"), rs.getString("owner_key"), rs.getString("input_confirmed_by"),
					rs.getObject("input_confirmed_at", OffsetDateTime.class), rs.getString("step")), versionId)
				.stream().findFirst();
	}

	/** 서버 사용자와 DB 시각을 쓰고, 재전송 시 기존 확인 값을 보존한다. */
	public void confirmVersion(long versionId, String ownerKey) {
		jdbcTemplate.update("""
				UPDATE work_version SET input_confirmed_by = ?, input_confirmed_at = now()
				WHERE input_version_id = ? AND input_confirmed_at IS NULL
				""", ownerKey, versionId);
	}

}
