package com.solution.operation.service.labor;

import com.solution.operation.service.OperationResultContract;

import static com.solution.operation.service.OperationResultContract.*;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;

import com.solution.operation.dto.StaffingPlan;

/** 가영 공유안의 직원별 staffing 어댑터. v1-proposal은 팀 검토용이며 기존 형식과 혼합하지 않는다. */
public final class SimulationStaffingMapper {
	public static final String VERSION = "operation.staffing.employees.v1-proposal";
	private static final Set<String> ROLES = Set.of("ORDER", "MAKE", "FLEX");
	private SimulationStaffingMapper() { }

	public static boolean usesEmployees(List<StaffingPlan> plans) {
		boolean rich = plans.stream().flatMap(p -> p.shifts().stream()).anyMatch(s -> s.primaryRole() != null);
		if (rich) require(plans.stream().flatMap(p -> p.shifts().stream()).allMatch(s -> s.primaryRole() != null));
		return rich;
	}

	public static List<Map<String, Object>> toChoices(List<StaffingPlan> plans) {
		List<Map<String, Object>> result = new ArrayList<>();
		for (StaffingPlan plan : plans) {
			List<Map<String, Object>> employees = plan.shifts().stream().map(s -> {
				require(s.primaryRole() != null && s.primaryRole().equals(s.taskCode()));
				Map<String, Object> employee = new LinkedHashMap<>();
				employee.put("staff_id", s.workerKey()); employee.put("primary_role", s.primaryRole());
				employee.put("can_support", s.canSupport()); employee.put("start_time", s.startTime()); employee.put("end_time", s.endTime());
				return employee;
			}).toList();
			Map<String, Object> staffing = Map.of("employees", employees);
			// Request validation uses exactly the same time/role checks as the response.
			readStaffing(plan.choiceKey(), staffing);
			result.add(Map.of("choice_key", plan.choiceKey(), "staffing", staffing));
		}
		require(result.size() == 3 && result.stream().map(x -> x.get("choice_key")).collect(java.util.stream.Collectors.toSet()).equals(CHOICES));
		return result;
	}

	public static List<StaffingPlan> fromData(Map<String, Object> data) {
		require(VERSION.equals(data.get("staffing_schema_version")));
		return plans(data).stream().map(p -> readStaffing((String) p.get("choice_key"), map(p.get("staffing")))).toList();
	}

	public static StaffingPlan readStaffing(String choiceKey, Map<String, Object> staffing) {
		require(choiceKey != null && CHOICES.contains(choiceKey));
		List<Map<String, Object>> employees = maps(staffing.get("employees"));
		require(!employees.isEmpty()); // time_slots/staff_count alone cannot identify paid workers.
		List<StaffingPlan.Shift> shifts = new ArrayList<>();
		Map<String, List<int[]>> byWorker = new LinkedHashMap<>();
		TreeMap<Integer, Integer> events = new TreeMap<>();
		int totalMinutes = 0;
		for (Map<String, Object> e : employees) {
			require(e.get("staff_id") instanceof String id && !id.isBlank() && id.length() <= 50);
			String id = (String) e.get("staff_id");
			require(e.get("primary_role") instanceof String && ROLES.contains(e.get("primary_role")));
			String role = (String) e.get("primary_role");
			require(e.get("can_support") instanceof List<?>);
			List<?> support = (List<?>) e.get("can_support");
			require(support.size() == new java.util.HashSet<>(support).size());
			require(support.stream().allMatch(x -> x instanceof String && Set.of("ORDER", "MAKE").contains(x) && !role.equals(x)));
			int start = minutes(e.get("start_time")), end = minutes(e.get("end_time"));
			require(start < end);
			for (int[] previous : byWorker.computeIfAbsent(id, ignored -> new ArrayList<>()))
				require(end <= previous[0] || previous[1] <= start);
			byWorker.get(id).add(new int[] {start, end});
			events.merge(start, 1, Integer::sum); events.merge(end, -1, Integer::sum);
			totalMinutes += end - start;
			shifts.add(new StaffingPlan.Shift(id, (String)e.get("start_time"), (String)e.get("end_time"), role,
					role, support.stream().map(String.class::cast).sorted().toList()));
		}
		int current = 0, peak = 0;
		for (int delta : events.values()) { current += delta; peak = Math.max(peak, current); }
		if (staffing.containsKey("peak_staff_count")) require(integer(staffing.get("peak_staff_count")) == peak);
		if (staffing.containsKey("total_staff_hours")) require(Math.abs(number(staffing.get("total_staff_hours")) * 60 - totalMinutes) < 0.000001);
		shifts.sort(Comparator.comparing(StaffingPlan.Shift::workerKey).thenComparing(StaffingPlan.Shift::startTime));
		return new StaffingPlan(choiceKey, shifts);
	}

	private static int minutes(Object value) {
		require(value instanceof String time && time.matches("(?:[01]\\d|2[0-3]):[0-5]\\d"));
		String t = (String) value;
		return Integer.parseInt(t.substring(0, 2)) * 60 + Integer.parseInt(t.substring(3));
	}
}
