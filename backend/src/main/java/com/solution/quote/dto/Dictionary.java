package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

//품목 사전 한 버전. 버전은 1 이상, items는 한 건 이상
public record Dictionary(@Min(1) int version, @NotEmpty List<@NotNull @Valid Item> items) {}
