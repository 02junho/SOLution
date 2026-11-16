package com.solution.session.service;

import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;

import com.solution.common.auth.CurrentOwner;
import com.solution.common.response.ApiResponse;
import com.solution.common.response.ResponseStatus;
import com.solution.session.dto.ConfirmInputRequest;
import com.solution.session.dto.ConfirmInputResponse;
import com.solution.session.service.SessionRepository.ConfirmationVersionRow;

@Service
public class WorkVersionService {

	private final SessionRepository repository;
	private final CurrentOwner currentOwner;
	private final TransactionTemplate transactionTemplate;

	public WorkVersionService(SessionRepository repository, CurrentOwner currentOwner,
			TransactionTemplate transactionTemplate) {
		this.repository = repository;
		this.currentOwner = currentOwner;
		this.transactionTemplate = transactionTemplate;
	}

	public ApiResponse<ConfirmInputResponse> confirmInput(long versionId, ConfirmInputRequest request) {
		String owner = currentOwner.key();
		ConfirmationVersionRow initial = ownedVersion(versionId, owner);
		return transactionTemplate.execute(status -> {
			// events와 같은 세션 행을 잠근 뒤 최신성·권한을 다시 읽는다.
			repository.lockSession(initial.sessionId());
			ConfirmationVersionRow row = ownedVersion(versionId, owner);
			if (row.versionNo() != row.currentVersion()
					|| request != null && request.expectedVersionNo() != null
						&& request.expectedVersionNo() != row.versionNo()) {
				throw InputConfirmException.stale();
			}
			if (row.inputConfirmedAt() == null) {
				repository.confirmVersion(versionId, owner);
				repository.updateSessionProgress(row.sessionId(), row.versionNo(), "review");
				row = ownedVersion(versionId, owner);
			}
			return new ApiResponse<>(ResponseStatus.OK, new ConfirmInputResponse(row.sessionId(), versionId,
					row.versionNo(), row.inputConfirmedBy(), row.inputConfirmedAt(), row.step()),
					"입력을 확인했어요. 이제 계산할 수 있어요.");
		});
	}

	private ConfirmationVersionRow ownedVersion(long versionId, String owner) {
		return repository.findConfirmationVersion(versionId).filter(row -> owner.equals(row.ownerKey()))
				.orElseThrow(InputConfirmException::notFound);
	}
}
