package com.solution.quote.dto;

import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.time.LocalDate;
import java.math.BigDecimal;
import java.util.*;

// AI 분석 요청. 공백이 아닌 견적 원문을 최대 15,000자로 받고, 거래처명과 use_rag는 선택 입력
public record Analyze(@NotBlank @Size(max=15000) String text, String supplier_name,
                   Boolean use_rag) {}
