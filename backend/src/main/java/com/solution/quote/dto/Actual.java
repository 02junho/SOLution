package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 과거 판매 실적 한 건. 메뉴 ID, 판매 잔수, 실적 기간
public record Actual(@NotBlank String menu_id, @NotNull @PositiveOrZero Integer cups,
                  @NotNull LocalDate start_date, @NotNull LocalDate end_date) {}
