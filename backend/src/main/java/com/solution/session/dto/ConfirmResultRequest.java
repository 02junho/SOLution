package com.solution.session.dto;

import java.util.List;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;

public record ConfirmResultRequest(@NotNull @Positive Long expectedInputVersionId,
		@NotBlank @Size(max = 50) String selectedChoiceKey,
		List<@NotBlank @Size(max = 100) String> acknowledgedWarningIds) {
}
