package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 매장 재고 묶음. 품목 ID → 재고 정보 형태
public record Stocks(@NotNull Map<@NotBlank String, @NotNull @Valid Stock> inventory) {}
