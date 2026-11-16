package com.solution.session.service;

import java.util.List;

import org.springframework.stereotype.Service;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.exception.ApiException;
import com.solution.common.response.ApiResponse;
import com.solution.session.dto.MessageHistoryResponse;
import com.solution.session.dto.MessageHistoryResponse.Item;

import tools.jackson.databind.ObjectMapper;

@Service
public class WorkMessageService {

	private final SessionRepository repository;
	private final CurrentOwner currentOwner;
	private final ObjectMapper objectMapper;

	public WorkMessageService(SessionRepository repository, CurrentOwner currentOwner, ObjectMapper objectMapper) {
		this.repository = repository;
		this.currentOwner = currentOwner;
		this.objectMapper = objectMapper;
	}

	public ApiResponse<MessageHistoryResponse> list(long sessionId, String cursor, int size) {
		String owner = currentOwner.key();
		repository.findSessionOwnerKey(sessionId).filter(owner::equals).orElseThrow(MessageHistoryException::new);
		if (size < 1 || size > 100) {
			throw ApiException.badRequest("페이지 크기는 1~100이어야 합니다.");
		}
		Long after = null;
		if (cursor != null) {
			try {
				if (!cursor.matches("[0-9]+")) {
					throw new NumberFormatException();
				}
				after = Long.parseLong(cursor);
				if (after <= 0) {
					throw new NumberFormatException();
				}
			}
			catch (NumberFormatException e) {
				throw ApiException.badRequest("커서는 양의 정수 범위의 메시지 번호여야 합니다.");
			}
		}
		var rows = repository.findMessages(sessionId, owner, after, size + 1);
		boolean hasNext = rows.size() > size;
		List<Item> items = rows.stream().limit(size).map(row -> new Item(row.messageId(), row.role(), row.content(),
				row.versionNo(), row.metadataJson() == null ? null : objectMapper.readValue(row.metadataJson(), Object.class),
				row.createdAt())).toList();
		String next = hasNext ? Long.toString(items.getLast().messageId()) : null;
		return ApiResponse.ok(new MessageHistoryResponse(items, next));
	}
}
