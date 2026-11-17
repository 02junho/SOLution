"""하루 계획표 생성. 근무시간을 바꾸지 않고 휴게를 배치한다."""

from collections import defaultdict

from app.core.response import infeasible, needs_input, ok
from app.tools.labor.policies import BREAK_POLICY_VERSIONS, required_break_seconds
from app.schemas.labor import Break, LaborInput, ScheduleRequest


def seconds(value: str) -> int:
    hour, minute = map(int, value.split(":"))
    return hour * 3600 + minute * 60


def clock(value: int) -> str:
    return f"{value // 3600:02d}:{value % 3600 // 60:02d}"


def overlap(a: tuple[int, int], b: tuple[int, int]) -> bool:
    return a[0] < b[1] and b[0] < a[1]


def validate_intervals(body: LaborInput) -> None:
    for plan in body.plans:
        grouped = defaultdict(list)
        for shift in plan.shifts:
            start, end = seconds(shift.start_time), seconds(shift.end_time)
            rest = sorted((seconds(b.start_time), seconds(b.end_time)) for b in shift.breaks)
            if any(a < start or z > end for a, z in rest):
                raise ValueError("휴게가 근무 구간 밖에 있습니다.")
            if any(overlap(a, b) for a, b in zip(rest, rest[1:])):
                raise ValueError("휴게 구간이 겹칩니다.")
            grouped[shift.worker_key].append((start, end))
        for intervals in grouped.values():
            intervals.sort()
            if any(overlap(a, b) for a, b in zip(intervals, intervals[1:])):
                raise ValueError("같은 직원의 근무 구간이 겹칩니다.")


def run(body: ScheduleRequest):
    validate_intervals(body)
    if body.rule_policy_version not in BREAK_POLICY_VERSIONS:
        return needs_input({"detail_status": "UNKNOWN_LABOR_POLICY", "missing_fields": [
            {"path": "rule_policy_version", "label": "확인된 근무 정책", "unit": None}
        ]}, "등록된 근무 정책을 확인해 주세요.")

    used_workers = {shift.worker_key for plan in body.plans for shift in plan.shifts}
    salaried = [{"path": f"workers[{i}].employment_type", "label": "정규직·고정급 적용 범위", "unit": None}
                for i, worker in enumerate(body.workers) if not worker.is_owner and worker.worker_key in used_workers
                and worker.employment_type == "salaried"]
    if salaried:
        return needs_input({"detail_status": "SALARIED_POLICY_REQUIRED", "missing_fields": salaried},
                           "정규직 배치·고정급 처리 범위는 팀 합의가 필요합니다. 시급 인력으로 바꾸어 계산하지 않습니다.")

    missing = [{"path": f"workers[{i}].is_minor", "label": f"{w.worker_key} 연소자 여부", "unit": None}
               for i, w in enumerate(body.workers) if not w.is_owner and w.worker_key in used_workers and w.is_minor is None]
    if missing:
        return needs_input({"detail_status": "MISSING_WORKER_CONTEXT", "missing_fields": missing},
                           "직원에게 적용할 근무시간 정책을 검사하려면 연소자 여부를 확인해야 합니다.")

    result = []
    violations = []
    avoid = [(seconds(w.start_time), seconds(w.end_time)) for w in body.avoid_break_windows]
    for original in body.plans:
        plan = original.model_copy(deep=True)
        for worker in body.workers:
            shifts = sorted((s for s in plan.shifts if s.worker_key == worker.worker_key),
                            key=lambda s: s.start_time)
            if not shifts or worker.is_owner:
                continue
            # 구간별 업무가 달라도 같은 사람의 하루 근무·휴게를 합쳐 검사한다.
            first, last = seconds(shifts[0].start_time), seconds(shifts[-1].end_time)
            if any(a.end_time != b.start_time for a, b in zip(shifts, shifts[1:])):
                violations.append(_violation(plan.choice_key, worker.worker_key, "SPLIT_SHIFT_UNSUPPORTED",
                                             "비연속 근무는 이번 자동 휴게 범위 밖입니다. 연속 근무 계획으로 확인해 주세요."))
                continue
            rests = [(seconds(b.start_time), seconds(b.end_time)) for s in shifts for b in s.breaks]
            if any(a <= first or z >= last for a, z in rests):
                raise ValueError("휴게는 직원의 전체 근무 도중에 있어야 합니다.")
            rest_total = sum(z-a for a, z in rests)
            span = last-first
            if rest_total < required_break_seconds(span-rest_total) and body.auto_break:
                # 30분 단위의 최소 추가 휴게. 체류시간과 유급시간을 혼동하지 않는다.
                additional = next((n for n in (1800, 3600) if rest_total+n >= required_break_seconds(span-rest_total-n)), None)
                candidates = []
                if additional is not None:
                    for shift in shifts:
                        for start in range(max(seconds(shift.start_time), first+60),
                                           min(seconds(shift.end_time)-additional, last-additional-60)+1, 60):
                            interval = (start, start+additional)
                            if not any(overlap(interval, rest) for rest in rests):
                                candidates.append((any(overlap(interval, window) for window in avoid), start, shift))
                if candidates:
                    target = first + (span - additional) // 2
                    _, start, shift = min(candidates, key=lambda row: (row[0], abs(row[1] - target), row[1]))
                    shift.breaks.append(Break(start_time=clock(start), end_time=clock(start+additional), is_paid=False))
                    shift.breaks.sort(key=lambda b: b.start_time)
                    rest_total += additional
            if rest_total < required_break_seconds(span-rest_total):
                violations.append(_violation(plan.choice_key, worker.worker_key, "REQUIRED_BREAK_UNPLACED",
                                             "지정한 근무 조건 안에서 필요한 휴게를 배치하지 못했습니다."))
            if worker.is_minor and span-rest_total > 7*3600:
                violations.append(_violation(plan.choice_key, worker.worker_key, "MINOR_DAILY_LIMIT",
                                             "연소자의 실제 근무가 하루 7시간을 넘습니다. 근무 조건을 확인해 주세요."))
        result.append({"choice_key": plan.choice_key,
                       "schedule": [s.model_dump(mode="json") for s in plan.shifts], "violations": []})
    if violations:
        return infeasible({"detail_status": "SCHEDULE_INFEASIBLE", "violations": violations,
                           "suggestions": ["근무시간 또는 지정 휴게 조건을 수정해 주세요."]},
                          "필수 조건을 충족하는 배치표를 만들지 못했습니다.")
    return ok({"session_id": body.session_id, "input_version_id": body.input_version_id,
               "rule_policy_version": body.rule_policy_version, "is_observation": False,
               "plans": result, "worker_context": {w.worker_key: {"is_owner": w.is_owner} for w in body.workers}, "warnings": [],
               "assumptions": ["계획 배치표이며 실제 근무 기록이 아닙니다.",
                               "휴게는 배치표에만 반영했고 시뮬레이션에는 반영하지 않았습니다.",
                               "하루 연속 근무의 휴게·연소자 일일 시간만 검사합니다. 가산수당·연차 등은 별도 확인 대상입니다."]})


def _violation(choice: str, worker: str, code: str, message: str) -> dict:
    return {"choice_key": choice, "worker_key": worker, "code": code, "message": message}
