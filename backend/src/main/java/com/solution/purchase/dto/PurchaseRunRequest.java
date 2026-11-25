package com.solution.purchase.dto;

import jakarta.validation.constraints.NotNull;

/** POST /api/v1/purchase/sessions/{session_id}/results 본문. 계산에 쓰는 숫자는 화면이 아니라 저장된 입력 버전에서 읽는다. */
public record PurchaseRunRequest(@NotNull Long inputVersionId) {
}
