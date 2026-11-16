package com.solution.session.dto;

import jakarta.validation.constraints.Positive;

public record ConfirmInputRequest(@Positive Integer expectedVersionNo) {
}
