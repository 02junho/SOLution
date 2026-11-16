package com.solution.session.dto;

import java.time.OffsetDateTime;

public record ConfirmInputResponse(long sessionId, long inputVersionId, int versionNo,
		String inputConfirmedBy, OffsetDateTime inputConfirmedAt, String step) {
}
