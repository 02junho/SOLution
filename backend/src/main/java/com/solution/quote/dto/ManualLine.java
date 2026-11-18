package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

//직접 견적 한 줄. 낱개 수량·단위, 묶음 개수, 가격, 가격 기준(per_pack 또는 per_unit), 부가세 상태를 받음
public record ManualLine(@NotBlank String supplier_name, @NotBlank String raw_item_name,
                      @NotNull @Positive BigDecimal quantity_per_unit,
                      @NotNull @Pattern(regexp = "kg|g|L|ml|개") String quantity_unit,
                      @NotNull @Positive Integer units_per_pack, @NotBlank String order_unit,
                      @NotNull @PositiveOrZero Integer price,
                      @NotNull @Pattern(regexp = "per_pack|per_unit") String price_basis,
                      @NotNull @Pattern(regexp = "included|excluded|unknown") String vat_status) {}
