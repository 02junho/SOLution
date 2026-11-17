"""배치·비용 예제만 실제 계산기로 갱신한다. 시뮬레이션 통계는 합성 계약 예제를 유지한다.

ai-server 폴더에서: PYTHONPATH=. python scripts/refresh_operation_demo.py
"""

import json
from pathlib import Path

from app.tools.labor import cost, schedule
from app.schemas.labor import CostRequest, ScheduleRequest

ROOT = Path(__file__).resolve().parents[2]
DATA = ROOT / "data/demo/operation"


def read(name):
    return json.loads((DATA / name).read_text(encoding="utf-8"))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def refresh():
    original = read("input.json")
    labor = original["labor"]
    context = {"session_id": 520001, "input_version_id": 530001,
               "business_date": original["business_date"], "workers": labor["workers"]}
    schedule_body = {**context, **{key: labor[key] for key in (
        "plans", "auto_break", "avoid_break_windows", "timezone", "rule_policy_version") if key in labor}}
    roster = schedule.run(ScheduleRequest.model_validate(schedule_body))
    assert roster.status == "ok", roster
    cost_body = {**context, **{key: original[key] for key in ("wage_year", "assumptions_version")},
                 **{key: labor[key] for key in ("cost_options", "weekly_context", "insurance_context", "monthly_projection") if key in labor},
                 "plans": [{"choice_key": plan["choice_key"], "shifts": plan["schedule"]} for plan in roster.data["plans"]]}
    money = cost.run(CostRequest.model_validate(cost_body))
    assert money.status == "ok", money
    write(DATA / "schedule_request.json", schedule_body)
    write(DATA / "cost_request.json", cost_body)
    write(DATA / "expected_cost.json", money.model_dump(mode="json"))

    fixture = read("compare_response.json")
    fixture["data"].update({"session_id": 520001, "input_version_id": 530001, "result_id": 7001,
                            "staffing": [{"choice_key": plan["choice_key"], "shifts": [
                                {key: shift[key] for key in ("worker_key", "start_time", "end_time", "task_code")}
                                for shift in plan["shifts"]]} for plan in labor["plans"]]})
    write(DATA / "compare_response.json", fixture)
    preview = read("preview.json")
    summary = preview["result"]["summary"]
    for plan in summary["choices"]:
        calculated = next(row for row in money.data["plans"] if row["choice_key"] == plan["choice_key"])
        for key in ("cash_cost_krw", "additional_cash_cost_krw", "owner_work_seconds", "cost_scope",
                    "monthly_cash_cost_estimate_krw", "additional_monthly_cash_cost_estimate_krw"):
            plan[key] = calculated[key]
        shifts = next(row["schedule"] for row in roster.data["plans"] if row["choice_key"] == plan["choice_key"])
        start, end = summary["comparison_window"]["start_time"], summary["comparison_window"]["end_time"]
        assignments = [{**{key: shift[key] for key in ("worker_key", "task_code")},
                        "start_time": max(start, shift["start_time"]), "end_time": min(end, shift["end_time"])}
                       for shift in shifts if shift["start_time"] < end and shift["end_time"] > start]
        changes = {}
        for row in assignments:
            changes[row["start_time"]] = changes.get(row["start_time"], 0) + 1
            changes[row["end_time"]] = changes.get(row["end_time"], 0) - 1
        current = maximum = 0
        for instant in sorted(changes):
            current += changes[instant]
            maximum = max(maximum, current)
        plan["staffing_summary"] = {"start_time": start, "end_time": end,
                                    "max_concurrent_workers": maximum, "assignments": assignments,
                                    "simulation_excludes_breaks": True}
    summary["warnings"] = [{"warning_id": "SIMULATED_CONDITIONS", "message": "모의 조건으로 계산한 결과입니다. 실측 결과가 아닙니다.", "requires_ack": True}]
    summary["assumptions"] = list(dict.fromkeys([
        "대기·비교 통계와 추천은 화면 연결용 합성 예제입니다. 실제 SimPy 실행 결과가 아닙니다.",
        *roster.data["assumptions"], *money.data["assumptions"]]))
    preview["result"]["detail"]["schedule"] = roster.data
    preview["result"]["detail"]["labor"] = money.data
    write(DATA / "preview.json", preview)
    write(ROOT / "frontend/src/features/operation/demo.json", preview)
    print("배치·비용 예제 갱신 완료. 대기 통계는 합성 계약 예제입니다.")


if __name__ == "__main__":
    refresh()
