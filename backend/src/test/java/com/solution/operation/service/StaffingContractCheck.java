package com.solution.operation.service;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.solution.common.client.AiServerException;
import com.solution.operation.dto.StaffingPlan;
import com.solution.operation.service.labor.SimulationStaffingMapper;

/** JDK21만으로 실행하는 계약 검증. Spring/DB/SimPy 통합 시험과 구분한다. */
public final class StaffingContractCheck {
	private static int checks;
	private StaffingContractCheck() { }
	public static void main(String[] args) { System.out.println("staffing contract checks: " + runChecks()); }

	public static int runChecks() {
		checks = 0;
		List<Map<String, Object>> choices = fixture();
		Map<String, Object> data = Map.of("staffing_schema_version", SimulationStaffingMapper.VERSION, "choices", choices);
		List<StaffingPlan> plans = SimulationStaffingMapper.fromData(data);
		check(plans.size() == 3, "three choices");
		check(plans.get(0).shifts().stream().mapToInt(StaffingContractCheck::duration).sum() == 24 * 60, "gross current24h");
		check(plans.get(2).shifts().stream().mapToInt(StaffingContractCheck::duration).sum() == 27 * 60, "gross C27h");
		check(plans.get(2).shifts().getLast().workerKey().equals("C"), "C identity");
		check(plans.get(1).shifts().getFirst().canSupport().equals(List.of("MAKE")), "primary versus support");
		check(SimulationStaffingMapper.toChoices(plans).size() == 3, "round trip");
		reject(() -> SimulationStaffingMapper.readStaffing("CURRENT", Map.of("time_slots", List.of(Map.of("staff_count", 2)))), "aggregate only");
		for (String bad : List.of("24", "07:60", "7:00")) {
			Map<String, Object> e = employee("A", "ORDER", List.of(), bad, "19:00");
			reject(() -> read(List.of(e)), "bad time");
		}
		reject(() -> read(List.of(employee("A", "ORDER", List.of(), "19:00", "07:00"))), "cross-midnight unsupported");
		Map<String, Object> a = employee("A", "ORDER", List.of(), "07:00", "19:00");
		reject(() -> read(List.of(a, a)), "overlapping duplicate worker");
		Map<String, Object> s = new LinkedHashMap<>(map(choices.getFirst().get("staffing")));
		s.put("total_staff_hours", 23);
		reject(() -> SimulationStaffingMapper.readStaffing("CURRENT", s), "wrong gross hours");
		s.put("total_staff_hours", 24); s.put("peak_staff_count", 3);
		reject(() -> SimulationStaffingMapper.readStaffing("CURRENT", s), "wrong peak");
		reject(() -> read(List.of(employee("A", "ORDER", List.of("ORDER"), "07:00", "19:00"))), "self support");
		reject(() -> read(List.of(employee("A", "ORDER", List.of("MAKE", "MAKE"), "07:00", "19:00"))), "duplicate support");
		reject(() -> read(List.of(employee("A", "UNKNOWN", List.of(), "07:00", "19:00"))), "unknown primary");
		Map<String, Object> missing = new LinkedHashMap<>(a); missing.remove("can_support");
		reject(() -> read(List.of(missing)), "missing support contract");
		OperationResultContract.validateClosing(null, 30); check(true, "missing closing stays missing");
		OperationResultContract.validateClosing(Map.of("failed_repetitions", 3, "success_ratio", 0.9), 30); check(true, "consistent closing");
		reject(() -> OperationResultContract.validateClosing(Map.of("failed_repetitions", 3, "success_ratio", 1.0), 30), "inconsistent closing");
		reject(() -> OperationResultContract.validateClosing(Map.of("failed_repetitions", 31, "success_ratio", 0.0), 30), "closing count exceeds repetitions");
		reject(() -> SimulationStaffingMapper.fromData(Map.of("choices", choices)), "missing proposal version");
		reject(() -> OperationResultContract.plans(Map.of("choices", choices, "results", choices)), "ambiguous choice containers");
		check(!SimulationStaffingMapper.usesEmployees(List.of(new StaffingPlan("CURRENT", List.of(new StaffingPlan.Shift("A", "07:00", "19:00", "ORDER_HANDOFF"))))), "legacy is not silently reinterpreted");
		var legacy = new StaffingPlan.Shift("B", "07:00", "19:00", "PREPARATION");
		reject(() -> SimulationStaffingMapper.usesEmployees(List.of(new StaffingPlan("CURRENT", List.of(plans.getFirst().shifts().getFirst(), legacy)))), "mixed contract");
		List<Map<String, Object>> shifts = plans.get(2).shifts().stream().map(StaffingPlan.Shift::asMap).toList();
		Map<String, Object> summary = StaffingSummary.from(Map.of("schedule", shifts), Map.of("start_time", "11:00", "end_time", "14:00"), Map.of("A", Map.of("is_owner", true)));
		check(summary.get("max_concurrent_workers").equals(3), "three workers at peak");
		check(summary.get("total_staff_hours").equals(27.0), "summary retains gross not paid hours");
		Map<String, Object> first = OperationResultContract.maps(summary.get("assignments")).getFirst();
		check(Boolean.TRUE.equals(first.get("is_owner")), "owner is explicit context");
		return checks;
	}

	private static StaffingPlan read(List<Map<String, Object>> employees) {
		return SimulationStaffingMapper.readStaffing("CURRENT", Map.of("employees", employees));
	}
	private static Map<String, Object> employee(String id, String role, List<String> support, String start, String end) {
		return Map.of("staff_id", id, "primary_role", role, "can_support", support, "start_time", start, "end_time", end);
	}
	private static List<Map<String, Object>> fixture() {
		List<Map<String, Object>> choices = new ArrayList<>();
		for (String key : List.of("CURRENT", "ALT_A", "ALT_C")) {
			List<Map<String, Object>> employees = new ArrayList<>();
			employees.add(employee("A", "ORDER", key.equals("ALT_A") ? List.of("MAKE") : List.of(), "07:00", "19:00"));
			employees.add(employee("B", "MAKE", key.equals("ALT_A") ? List.of("ORDER") : List.of(), "07:00", "19:00"));
			if (key.equals("ALT_C")) employees.add(employee("C", "MAKE", List.of("ORDER"), "11:00", "14:00"));
			choices.add(Map.of("choice_key", key, "staffing", Map.of("employees", employees,
					"peak_staff_count", key.equals("ALT_C") ? 3 : 2, "total_staff_hours", key.equals("ALT_C") ? 27 : 24)));
		}
		return choices;
	}
	private static Map<String, Object> map(Object o) { return OperationResultContract.map(o); }
	private static int duration(StaffingPlan.Shift s) { return minutes(s.endTime()) - minutes(s.startTime()); }
	private static int minutes(String s) { return Integer.parseInt(s.substring(0,2))*60+Integer.parseInt(s.substring(3)); }
	private static void check(boolean condition, String label) { if (!condition) throw new AssertionError(label); checks++; }
	private static void reject(Runnable action, String label) {
		try { action.run(); } catch (AiServerException expected) { checks++; return; }
		throw new AssertionError("not rejected: " + label);
	}
}
