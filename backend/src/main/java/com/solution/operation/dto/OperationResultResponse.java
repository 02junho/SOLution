package com.solution.operation.dto;

import java.time.OffsetDateTime;
import java.util.LinkedHashMap;
import java.util.Map;

/** 운영 결과의 공통 식별·버전 DTO. summary/detail 또는 업무 실패 데이터는 서비스에서 결합한다. */
public record OperationResultResponse(long resultId, long sessionId, long inputVersionId, int versionNo,
		String responseStatus, String detailStatus, OffsetDateTime createdAt, boolean latestVersion, String confirmedChoiceKey) {
	public Map<String, Object> asMap() {
		Map<String, Object> data = new LinkedHashMap<>();
		data.put("result_id", resultId); data.put("session_id", sessionId); data.put("input_version_id", inputVersionId);
		data.put("version_no", versionNo); data.put("feature_type", "operation"); data.put("response_status", responseStatus);
		data.put("detail_status", detailStatus); data.put("created_at", createdAt); data.put("is_latest_version", latestVersion);
		data.put("confirmed_choice_key", confirmedChoiceKey); return data;
	}
}
