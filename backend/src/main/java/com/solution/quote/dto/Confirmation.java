package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

//	거래처 견적 확인 여부. confirmed에 true 또는 false를 받음
public record Confirmation(@NotNull Boolean confirmed) {}
