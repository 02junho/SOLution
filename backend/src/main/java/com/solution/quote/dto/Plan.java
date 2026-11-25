package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 	메뉴별 판매 계획 한 건. 계획 잔수와 선택 입력인 포장 잔수를 담습니다. 포장 잔수 null과 0은 각각 미입력과 포장 판매 없음으로 구분
public record Plan(@NotBlank String menu_id, @NotNull @PositiveOrZero Integer cups,
                @PositiveOrZero Integer takeaway_cups) {}
