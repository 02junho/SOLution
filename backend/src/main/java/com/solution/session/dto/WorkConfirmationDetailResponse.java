package com.solution.session.dto;

import java.time.OffsetDateTime;

import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.annotation.JsonRawValue;

/** 저장된 JSON을 문자열로 이중 인코딩하거나 현재 결과로 다시 계산하지 않고 반환한다. */
public record WorkConfirmationDetailResponse(long confirmationId, long resultId, long inputVersionId,
		long sessionId, String featureType, String selectedChoiceKey, String confirmedBy, OffsetDateTime confirmedAt,
		@JsonProperty("is_current_version") boolean isCurrentVersion,
		@JsonRawValue String acknowledgedWarningsJson, @JsonRawValue String selectedSnapshotJson) {
}
