"""일주일 근무표 한 번에(week_plan): 요일별 필요 인원 → 두 근무조 → 명단 배정."""

import pytest

from app.tools.simulation import week_plan
from app.tools.simulation.daily_roster import plan as daily_plan
from tests.test_operation_store_data import HOURLY

W5 = ["MON", "TUE", "WED", "THU", "FRI"]


def _day(day, factor, owner=True):
    slots = {k: max(0, round(v * factor)) for k, v in HOURLY.items()}
    return {
        "day": day,
        "roster": {
            "scenario": {"orders_by_slot": slots},
            "repetitions": 5,
            "owner": {"is_working": owner, **({"start_time": "08:00", "end_time": "14:00"} if owner else {})},
            "hourly_wage_krw": 10320,
            "business_date": "2026-11-20",
        },
    }


def _worker(key, days, a="08:00", b="20:00", cap=40):
    return {"worker_key": key, "hourly_wage_krw": 10320, "available": {d: [a, b] for d in days}, "max_weekly_hours": cap}


TEAM = [_worker("A", W5), _worker("B", W5, "11:00", "20:00"), _worker("C", W5, cap=14), _worker("D", W5, cap=14),
        _worker("E", W5, cap=14), _worker("F", W5, cap=14)]


def test_two_shift_rules_from_one_staffing_check_and_assignment():
    data = week_plan.plan({"days": [_day("MON", 1.0), _day("TUE", 0.8, owner=False)], "workers": TEAM}, engine="reference")
    assert data["skipped_days"] == []
    by_mode = {r["mode"]: r for r in data["results"]}
    holiday, under = by_mode["WITH_HOLIDAY_PAY"], by_mode["UNDER_15H"]
    for day in ("MON", "TUE"):
        # 필요 인원은 두 안이 같다(한 번만 찾음)
        assert [x["required_staff"] for x in holiday["days"][day]["required_by_slot"]] == [
            x["required_staff"] for x in under["days"][day]["required_by_slot"]
        ]
        for s in under["days"][day]["shifts"]:
            if not s["is_owner"]:
                assert s["span_hours"] <= 5
    for r in (holiday, under):
        w = r["weekly"]
        slots = sum(len([s for s in v["shifts"] if not s["is_owner"]]) for v in r["days"].values())
        assert len(w["assignments"]) + len(w["unfilled"]) == slots
        assert w["optimal"] is True
    assert all(x["weekly_work_hours"] < 15 for x in under["weekly"]["workers"])
    # 하루 근무표만 따로 만든 것과 같은 근무조(주휴 포함 안 = 기본 규칙)
    single = daily_plan(_day("MON", 1.0)["roster"], engine="reference")
    assert [(s["start_time"], s["end_time"]) for s in single["shifts"]] == [
        (s["start_time"], s["end_time"]) for s in holiday["days"]["MON"]["shifts"]
    ]


def test_bad_day_is_reported_not_invented():
    bad = _day("WED", 1.0)
    bad["roster"]["scenario"] = {"daily_orders": 0}
    data = week_plan.plan({"days": [_day("MON", 1.0), bad], "workers": TEAM}, engine="reference")
    assert [d["day"] for d in data["skipped_days"]] == ["WED"]
    assert "WED" not in data["results"][0]["days"]


def test_rejects_duplicate_days():
    with pytest.raises(ValueError):
        week_plan.plan({"days": [_day("MON", 1.0), _day("MON", 1.0)], "workers": TEAM}, engine="reference")


def test_router_week_plan():
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = fastapi.FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    body = {"days": [_day("MON", 0.6)], "workers": TEAM[:2], "weekly_mode": "UNDER_15H"}
    response = TestClient(app).post("/tools/simulation/week-plan", json=body, headers={"X-Request-Key": "wk"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["model_version"] == "operation.week_plan.v1" and [r["mode"] for r in data["results"]] == ["UNDER_15H"]
