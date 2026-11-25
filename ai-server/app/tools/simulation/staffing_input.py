"""Spring(operation)이 보내는 근무표를 엔진 구간표로 바꾼다.

두 가지 형식을 받는다(Spring FastApiSimulationService와 같은 구분).
- plans: 기존 형식. 안마다 shifts[{worker_key, start_time, end_time, task_code}]
- choices + staffing_schema_version: 직원별 형식. 안마다 staffing.employees[{staff_id, primary_role, can_support, ...}]

받은 근무표를 그대로 시뮬레이션하고, 응답에는 실제로 돌린 근무표를 같은 모양으로 돌려준다.
휴게(breaks)는 시뮬레이션에 넣지 않는다(labor 배치표에서만 다룸).
"""

from __future__ import annotations

from .day_simulation import roster_from_shifts

CHOICES = ("CURRENT", "ALT_A", "ALT_C")
EMPLOYEE_SCHEMA_VERSION = "operation.staffing.employees.v1-proposal"
SHIFT_KEYS = ("worker_key", "start_time", "end_time", "task_code")


class StaffingInput:
    def __init__(self, mode: str, rosters: dict, echo: list):
        self.mode = mode  # 'plans' 또는 'employees'
        self.rosters = rosters  # choice_key -> 구간표
        self.echo = echo  # 응답에 그대로 돌려줄 근무표


def _choice_rows(rows, name):
    if not isinstance(rows, list) or len(rows) != 3:
        raise ValueError(f"{name}에는 CURRENT·ALT_A·ALT_C 세 안이 있어야 합니다.")
    keys = [row.get("choice_key") if isinstance(row, dict) else None for row in rows]
    if sorted(k or "" for k in keys) != sorted(CHOICES):
        raise ValueError(f"{name}에는 CURRENT·ALT_A·ALT_C를 하나씩 보내 주세요.")
    return {row["choice_key"]: row for row in rows}


def _text(value, name):
    if not isinstance(value, str) or not value:
        raise ValueError(f"{name} 값이 필요합니다.")
    return value


def parse(body: dict) -> StaffingInput | None:
    """근무표가 없으면 None(엔진이 정한 세 안으로 계산). 있으면 안별 구간표."""
    plans, choices, version = (
        body.get("plans"),
        body.get("choices"),
        body.get("staffing_schema_version"),
    )
    if plans is None and choices is None and version is None:
        return None
    if plans is not None and choices is not None:
        raise ValueError("plans와 choices 중 하나만 보내 주세요.")
    if choices is not None or version is not None:
        if version != EMPLOYEE_SCHEMA_VERSION or choices is None:
            raise ValueError(
                f"직원별 근무표는 staffing_schema_version={EMPLOYEE_SCHEMA_VERSION}와 choices가 함께 필요합니다."
            )
        rows = _choice_rows(choices, "choices")
        rosters, echo = {}, []
        for key in CHOICES:
            staffing = (
                rows[key].get("staffing")
                if isinstance(rows[key].get("staffing"), dict)
                else {}
            )
            employees = staffing.get("employees")
            if not isinstance(employees, list) or not employees:
                raise ValueError(f"{key} 안의 직원 근무가 비어 있습니다.")
            shifts, kept = [], []
            for e in employees:
                if not isinstance(e, dict):
                    raise ValueError(f"{key} 안의 직원 근무 항목은 객체여야 합니다.")
                support = e.get("can_support") or []
                shift = {
                    "worker_key": _text(e.get("staff_id"), "staff_id"),
                    "start_time": _text(e.get("start_time"), "start_time"),
                    "end_time": _text(e.get("end_time"), "end_time"),
                    "primary_role": _text(e.get("primary_role"), "primary_role"),
                    "can_support": list(support),
                }
                shifts.append(shift)
                kept.append(
                    {
                        "staff_id": shift["worker_key"],
                        "primary_role": shift["primary_role"],
                        "can_support": list(support),
                        "start_time": shift["start_time"],
                        "end_time": shift["end_time"],
                    }
                )
            rosters[key] = roster_from_shifts(shifts)
            echo.append({"choice_key": key, "staffing": {"employees": kept}})
        return StaffingInput("employees", rosters, echo)
    rows = _choice_rows(plans, "plans")
    rosters, echo = {}, []
    for key in CHOICES:
        shifts = rows[key].get("shifts")
        if not isinstance(shifts, list) or not shifts:
            raise ValueError(f"{key} 안의 근무가 비어 있습니다.")
        kept = []
        for shift in shifts:
            if not isinstance(shift, dict):
                raise ValueError("근무 구간 형식이 올바르지 않습니다.")
            row = {k: _text(shift.get(k), k) for k in SHIFT_KEYS}
            if shift.get("primary_role") is not None:
                row["primary_role"] = shift["primary_role"]
                row["can_support"] = list(shift.get("can_support") or [])
            kept.append(row)
        rosters[key] = roster_from_shifts(kept)
        echo.append({"choice_key": key, "shifts": kept})
    return StaffingInput("plans", rosters, echo)


def simulated_staffing(rows) -> dict:
    """화면용: 시뮬레이션이 실제로 쓴 구간별 인원·역할. 휴게·급여는 포함하지 않는다."""
    segments = []
    for row in rows:
        names = row.get("worker_keys") or []
        people = [
            {
                "worker_key": names[i] if i < len(names) else f"EMP_{i + 1:02d}",
                "primary_roles": list(groups[0]),
                "can_support": list(dict.fromkeys(t for g in groups[1:] for t in g)),
            }
            for i, groups in sorted(row["assignments"].items())
        ]
        segments.append(
            {
                "start_time": row["start"],
                "end_time": row["end"],
                "staff_count": row["staff_count"],
                "people": people,
            }
        )
    total = round(
        sum((r["end_sec"] - r["start_sec"]) * r["staff_count"] / 3600 for r in rows), 4
    )
    return {
        "segments": segments,
        "peak_staff_count": max(r["staff_count"] for r in rows),
        "total_staff_hours": total,
        "unit": "person_hour",
        "breaks_included": False,
        "note": "받은 근무표대로 시뮬레이션한 구간별 인원·역할. 휴게는 반영하지 않았습니다.",
    }
