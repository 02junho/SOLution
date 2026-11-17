package com.solution.operation.dto;

import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;

/** 계산 숫자는 본문에서 받지 않고 저장된 work_version에서 읽는다. */
public record OperationRunRequest(@NotNull @Positive Long inputVersionId) {
}
