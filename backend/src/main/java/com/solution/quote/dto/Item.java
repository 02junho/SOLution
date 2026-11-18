package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 사전의 품목 한 개. 품목 ID, 이름, 기준 단위(g, ml, 개), 별칭, 규격 목록
public record Item(@NotBlank String item_id, @NotBlank String name,
                @NotNull @Pattern(regexp = "g|ml|개") String base_unit,
                List<@NotBlank String> aliases, List<@NotBlank String> specifications) {}
