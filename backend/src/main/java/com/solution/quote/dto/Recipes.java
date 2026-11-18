package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

//	메뉴별 재료표 묶음. 메뉴 ID → 재료 행 목록 형태
public record Recipes(@NotEmpty Map<@NotBlank String, @NotEmpty List<@NotNull @Valid RecipeLine>> recipes) {}
