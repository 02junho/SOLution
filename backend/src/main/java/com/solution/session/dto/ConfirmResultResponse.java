package com.solution.session.dto;

import java.time.OffsetDateTime;

import com.fasterxml.jackson.annotation.JsonProperty;

public record ConfirmResultResponse(long confirmationId, long resultId, long inputVersionId, long sessionId,
		long storeId, int versionNo, String featureType, String selectedChoiceKey, String confirmedBy,
		OffsetDateTime confirmedAt, @JsonProperty("is_new") boolean isNew,
		@JsonProperty("is_current_version") boolean isCurrentVersion, String step) {
}
