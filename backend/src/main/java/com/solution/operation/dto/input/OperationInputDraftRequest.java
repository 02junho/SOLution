package com.solution.operation.dto.input;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

/**
 * 운영 실험 폼에서 사장님이 고르는 값. 운영 계산에 필요한 전체 입력(simulation·labor)은
 * OperationInputBuilder가 이 값으로 만든다. 비워 둔 칸은 정해 둔 기본값을 쓴다.
 *
 * <p>근무는 고정 가정이다: 2명이 07~19시 모두 일하고, 서로 돕기·한 명 추가는 바쁜 시간(기본 11~14시)에만 바뀐다.
 * 시간대별 인원 나누기(배치표 생성)는 노동 쪽 기능이 생기면 붙인다.
 *
 * @param businessDate 영업일. 없으면 오늘(Asia/Seoul)
 * @param dailyOrders 하루 예상 주문 수. 30회 반복 계산이 120초 안에 끝나도록 300건까지
 * @param lastOrderTime 라스트 오더(18:30~19:00). 없으면 18:45
 * @param selectedMenuIds 파는 메뉴. 없으면 기본 메뉴 전체
 * @param isOwnerWorking 사장님이 직접 일하는지. 일하면 사장님이 07~19시 주문·전달을 맡고 급여에서 빠진다
 * @param hourlyWageKrw 직원 시급. 영업일이 속한 해의 최저시급 미만이면 400
 * @param isStaffMinor 직원이 연소자(18세 미만)인지. 없으면 아니라고 본다
 * @param rushStartTime 바쁜 시간 시작(HH:mm, 07~19시). 서로 돕기·한 명 추가가 바뀌고 휴게를 피하는 구간. 없으면 11:00
 * @param rushEndTime 바쁜 시간 끝(HH:mm). 시작보다 늦어야 한다. 없으면 14:00
 * @param menuWeights 고른 메뉴의 판매 비중(합계 1). 없으면 엔진 기본 비중
 * @param orderTimeSec 주문·결제 평균 초(없으면 엔진 기본 60초)
 * @param handoffTimeSec 음료 전달 평균 초(없으면 엔진 기본 30초)
 */
public record OperationInputDraftRequest(
		LocalDate businessDate,
		@NotNull @Min(1) @Max(300) Integer dailyOrders,
		String lastOrderTime,
		List<String> selectedMenuIds,
		@NotNull Boolean isOwnerWorking,
		@NotNull @Min(1) @Max(1_000_000) Integer hourlyWageKrw,
		Boolean isStaffMinor,
		String rushStartTime,
		String rushEndTime,
		Map<String, Double> menuWeights,
		@Min(1) @Max(300) Integer orderTimeSec,
		@Min(1) @Max(300) Integer handoffTimeSec) {
}
