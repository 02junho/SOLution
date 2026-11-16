package com.solution.session.dto;

import java.time.OffsetDateTime;
import java.util.List;

public record MessageHistoryResponse(List<Item> items, String nextCursor) {

	public record Item(long messageId, String role, String content, Integer versionNo,
			Object metadataJson, OffsetDateTime createdAt) {
	}
}
