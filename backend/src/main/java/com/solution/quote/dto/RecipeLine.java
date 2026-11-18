package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 재료표 한 줄. 예: 라떼 한 잔에 우유 200ml. scope가 all이면 전체 판매 잔수에, takeaway면 포장 잔수에 적용
public record RecipeLine(@NotBlank String item_id, @NotNull @Pattern(regexp = "g|ml|개") String unit,
                      @NotNull @Positive BigDecimal amount_per_cup,
                      @NotNull @Pattern(regexp = "all|takeaway") String scope) {}
