package com.solution.operation.dto.input;

import java.time.LocalDate;
import java.util.List;
import java.util.Map;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotNull;

/**
 * 운영 실험 폼에서 사장님이 고르는 값. 저장 입력은 이 값만 담고({"operation_form": {...}}),
 * 운영 계산에 필요한 전체 입력(simulation·labor 근무표 세 안)은 계산할 때 OperationInputBuilder가 만든다.
 * 비워 둔 칸은 정해 둔 기본값을 쓴다.
 *
 * <p>근무는 고정 가정이다: 2명이 오픈~마감(기본 07~19시) 모두 일하고, 서로 돕기·한 명 추가는 바쁜 시간에만 바뀐다.
 * 바쁜 시간은 입력으로 받지 않고 상권 데이터에서 손님이 가장 몰리는 시간대(OperationInputBuilder.PEAK_START~PEAK_END)를 쓴다.
 * 시간대별 인원 나누기(배치표 생성)는 노동 쪽 기능이 생기면 붙인다.
 *
 * @param businessDate 영업일. 없으면 오늘(Asia/Seoul)
 * @param dailyOrders 하루 예상 주문 수. 30회 반복 계산이 120초 안에 끝나도록 300건까지
 * @param lastOrderTime 라스트 오더(18:30~19:00). 없으면 18:45
 * @param selectedMenuIds 파는 메뉴. 없으면 기본 메뉴 전체
 * @param isOwnerWorking 사장님이 직접 일하는지. 일하면 사장님이 오픈~마감 주문·전달을 맡고 급여에서 빠진다
 * @param hourlyWageKrw 직원 시급. 영업일이 속한 해의 최저시급 미만이면 400
 * @param isStaffMinor 직원이 연소자(18세 미만)인지. 없으면 아니라고 본다
 * @param menuWeights 고른 메뉴의 판매 비중(합계 1). 없으면 엔진 기본 비중
 * @param orderTimeSec 주문·결제 평균 초(없으면 엔진 기본 60초)
 * @param handoffTimeSec 음료 전달 평균 초(없으면 엔진 기본 30초)
 * @param openTime 오픈 시각(06:00~10:30, 30분 단위). 없으면 07:00
 * @param closeTime 마감 시각(17:30~21:00, 30분 단위). 없으면 19:00
 * @param menuCups 가게 데이터: 메뉴별 하루 잔 수. 있으면 하루 주문 수(합계)·메뉴·판매 비중을 여기서 정한다
 * @param manufactureSecByMenu 가게 데이터: 메뉴별 한 잔 제조시간(초, 10~600). 없는 메뉴는 엔진 기본값
 * @param ordersBySlot 가게 데이터: 시간대별 주문 수("08:00-09:00" → 건수). 있으면 영업시간·하루 주문 수를 여기서 정한다
 * @param peakStartTime 바쁜 시간 시작(서로 돕기·한 명 추가가 바뀌는 구간). 없으면 11:00
 * @param peakEndTime 바쁜 시간 끝. 없으면 14:00
 * @param espressoMachines 에스프레소 머신 대수(1~3, 스팀도 같은 수). 없으면 1
 * @param blenders 블렌더 대수(1~3). 없으면 1
 * @param targetWaitSec 목표 대기: 주문 후 받기까지 손님 90%가 이 시간 안(120~600초). 없으면 300초(5분)
 */
public record OperationInputDraftRequest(
		LocalDate businessDate,
		@Min(1) @Max(300) Integer dailyOrders,
		String lastOrderTime,
		List<String> selectedMenuIds,
		@NotNull Boolean isOwnerWorking,
		@NotNull @Min(1) @Max(1_000_000) Integer hourlyWageKrw,
		Boolean isStaffMinor,
		Map<String, Double> menuWeights,
		@Min(1) @Max(300) Integer orderTimeSec,
		@Min(1) @Max(300) Integer handoffTimeSec,
		String openTime,
		String closeTime,
		Map<String, Integer> menuCups,
		Map<String, Integer> manufactureSecByMenu,
		Map<String, Integer> ordersBySlot,
		String peakStartTime,
		String peakEndTime,
		Integer espressoMachines,
		Integer blenders,
		Integer targetWaitSec) {

	/** 가게 데이터·영업시간 없이(지금 버전 폼). */
	public OperationInputDraftRequest(LocalDate businessDate, Integer dailyOrders, String lastOrderTime,
			List<String> selectedMenuIds, Boolean isOwnerWorking, Integer hourlyWageKrw, Boolean isStaffMinor,
			Map<String, Double> menuWeights, Integer orderTimeSec, Integer handoffTimeSec) {
		this(businessDate, dailyOrders, lastOrderTime, selectedMenuIds, isOwnerWorking, hourlyWageKrw, isStaffMinor,
				menuWeights, orderTimeSec, handoffTimeSec, null, null, null, null, null, null, null, null, null, null);
	}

	/** 시간대별 주문·바쁜 시간 없이(영업시간·잔 수·제조시간까지). */
	public OperationInputDraftRequest(LocalDate businessDate, Integer dailyOrders, String lastOrderTime,
			List<String> selectedMenuIds, Boolean isOwnerWorking, Integer hourlyWageKrw, Boolean isStaffMinor,
			Map<String, Double> menuWeights, Integer orderTimeSec, Integer handoffTimeSec, String openTime,
			String closeTime, Map<String, Integer> menuCups, Map<String, Integer> manufactureSecByMenu) {
		this(businessDate, dailyOrders, lastOrderTime, selectedMenuIds, isOwnerWorking, hourlyWageKrw, isStaffMinor,
				menuWeights, orderTimeSec, handoffTimeSec, openTime, closeTime, menuCups, manufactureSecByMenu, null,
				null, null, null, null, null);
	}

	/** 기계 대수·목표 대기 없이(시간대별 주문·바쁜 시간까지). */
	public OperationInputDraftRequest(LocalDate businessDate, Integer dailyOrders, String lastOrderTime,
			List<String> selectedMenuIds, Boolean isOwnerWorking, Integer hourlyWageKrw, Boolean isStaffMinor,
			Map<String, Double> menuWeights, Integer orderTimeSec, Integer handoffTimeSec, String openTime,
			String closeTime, Map<String, Integer> menuCups, Map<String, Integer> manufactureSecByMenu,
			Map<String, Integer> ordersBySlot, String peakStartTime, String peakEndTime) {
		this(businessDate, dailyOrders, lastOrderTime, selectedMenuIds, isOwnerWorking, hourlyWageKrw, isStaffMinor,
				menuWeights, orderTimeSec, handoffTimeSec, openTime, closeTime, menuCups, manufactureSecByMenu,
				ordersBySlot, peakStartTime, peakEndTime, null, null, null);
	}
}
