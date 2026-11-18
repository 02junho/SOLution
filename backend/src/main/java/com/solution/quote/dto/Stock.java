package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 재고 품목 한 개. 단위, 사용 가능 재고, 안전재고를 받습니다. 두 수량 모두 0 이상
public record Stock(@NotNull @Pattern(regexp = "g|ml|개") String unit,
                 @NotNull @PositiveOrZero BigDecimal usable_inventory,
                 @NotNull @PositiveOrZero BigDecimal safety_stock) {}
