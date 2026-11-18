package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// 	직접 입력한 견적 묶음. ManualLine을 한 건 이상 받음
public record ManualQuote(@NotEmpty List<@NotNull @Valid ManualLine> items) {}
