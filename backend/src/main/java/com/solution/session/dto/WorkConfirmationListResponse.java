package com.solution.session.dto;

import java.time.OffsetDateTime;
import java.util.List;

import com.fasterxml.jackson.annotation.JsonProperty;

public record WorkConfirmationListResponse(List<Item> items, String nextCursor) {

	public record Item(long confirmationId, long sessionId, String featureType, String selectedChoiceKey,
			int versionNo, @JsonProperty("is_current_version") boolean isCurrentVersion, OffsetDateTime confirmedAt) {
	}
}
