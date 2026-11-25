package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 한 작업의 판매 기간과 판매 데이터
public record Sales(@NotNull LocalDate start_date, @NotNull LocalDate end_date,
                 @NotNull List<@NotNull @Valid Actual> recent_actuals,
                 @NotNull List<@NotNull @Valid Plan> sales_plan) {}
