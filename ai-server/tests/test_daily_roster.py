"""하루 근무표 자동 생성(daily_roster): 필요 인원 → 근무조 → 휴게 → 휴게 포함 검증."""

import pytest

from app.tools.simulation import daily_roster
from app.tools.simulation.daily_roster import _cover, plan
from tests.test_operation_store_data import HOURLY

BASE = {"repetitions": 10, "hourly_wage_krw": 10320, "business_date": "2026-11-20"}


def _minutes(t):
    return int(t[:2]) * 60 + int(t[3:])


def _on_duty(result, at):
    """그 시각에 일하는 사람 수(휴게 중 제외)."""
    m = _minutes(at)
    n = 0
    for s in result["shifts"]:
        if _minutes(s["start_time"]) <= m < _minutes(s["end_time"]) and not any(
            _minutes(b["start_time"]) <= m < _minutes(b["end_time"]) for b in s["breaks"]
        ):
            n += 1
    return n


def test_cover_uses_long_and_short_shifts_and_meets_need():
    need = [1] * 16 + [2] * 6 + [1] * 2  # 30분 칸: 8시간 1명, 3시간 2명, 1시간 1명
    shifts = _cover(need, 16, 8)
    have = [sum(a <= u < b for a, b, _ in shifts) for u in range(len(need))]
    assert all(h >= n for h, n in zip(have, need))
    assert all(8 <= b - a <= 16 for a, b, _ in shifts)
    assert {kind for *_, kind in shifts} <= {"LONG", "SHORT"}


def test_store_day_with_owner_builds_roster_breaks_and_cost():
    result = plan(
        {
            **BASE,
            "scenario": {"orders_by_slot": HOURLY, "peak_start_time": "12:00", "peak_end_time": "14:00"},
            "owner": {"is_working": True},
        },
        engine="reference",
    )
    assert [r["slot"] for r in result["required_by_slot"]] == list(HOURLY)
    owner = next(s for s in result["shifts"] if s["is_owner"])
    assert (owner["start_time"], owner["end_time"]) == ("08:00", "20:00") and owner["breaks"] == []
    staff = [s for s in result["shifts"] if not s["is_owner"]]
    assert staff, "사장님 혼자서는 바쁜 시간을 못 버틴다"
    for s in staff:
        span = _minutes(s["end_time"]) - _minutes(s["start_time"])
        assert 4 * 60 <= span <= 8 * 60
        # 노동 규칙: 4시간 이상이면 30분 이상 쉰다
        assert s["break_minutes"] >= 30
    # 시간대마다 근무표 인원이 필요 인원 이상(휴게 시간은 빼고 본 최소값은 검증으로 확인)
    for row in result["required_by_slot"]:
        assert row["on_roster_max"] >= row["required_staff"]
    assert result["verification"]["with_breaks"] is True
    assert result["verification"]["passes"] is True
    paid = sum((_minutes(s["end_time"]) - _minutes(s["start_time"]) - s["break_minutes"]) / 60 for s in staff)
    assert result["cost"]["employee_paid_hours"] == pytest.approx(paid)
    assert result["cost"]["cash_cost_krw"] == round(paid * 10320)


def test_breaks_avoid_leaving_the_store_empty_when_someone_else_is_there():
    result = plan({**BASE, "scenario": {"daily_orders": 150}, "owner": {"is_working": False}}, engine="reference")
    for s in result["shifts"]:
        for b in s["breaks"]:
            assert _on_duty(result, b["start_time"]) >= 1, (s, b)


def test_owner_hours_reduce_staff_needed_during_those_hours():
    full = plan({**BASE, "scenario": {"daily_orders": 120}, "owner": {"is_working": True}}, engine="reference")
    morning = plan(
        {**BASE, "scenario": {"daily_orders": 120}, "owner": {"is_working": True, "start_time": "07:00", "end_time": "12:00"}},
        engine="reference",
    )
    assert morning["cost"]["employee_paid_hours"] > full["cost"]["employee_paid_hours"]
    owner = next(s for s in morning["shifts"] if s["is_owner"])
    assert owner["end_time"] == "12:00"


def test_minor_staff_shifts_stay_within_seven_working_hours():
    result = plan(
        {**BASE, "scenario": {"daily_orders": 150}, "owner": {"is_working": False}, "is_staff_minor": True},
        engine="reference",
    )
    for s in result["shifts"]:
        assert _minutes(s["end_time"]) - _minutes(s["start_time"]) - s["break_minutes"] <= 7 * 60


@pytest.mark.parametrize(
    "change,message",
    [
        ({"owner": {"is_working": True, "start_time": "06:00"}}, "사장님 근무시간"),
        ({"roster_rules": {"long_shift_hours": 12}}, "긴 조"),
        ({"roster_rules": {"short_shift_hours": 9, "long_shift_hours": 8}}, "짧은 조"),
    ],
)
def test_rejects_bad_people_rules(change, message):
    with pytest.raises(ValueError, match=message):
        plan({**BASE, "scenario": {"daily_orders": 80}, **change}, engine="reference")


def test_too_many_orders_for_roster_search_is_needs_input(monkeypatch):
    monkeypatch.setattr(daily_roster, "MAX_ORDER_RUNS", 500)
    with pytest.raises(ValueError, match="NEEDS_INPUT"):
        plan({**BASE, "scenario": {"daily_orders": 80}}, engine="reference")


def test_router_daily_roster():
    fastapi = pytest.importorskip("fastapi")
    pytest.importorskip("simpy")
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = fastapi.FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    client = TestClient(app)
    body = {
        "scenario": {"orders_by_slot": HOURLY},
        "repetitions": 5,
        "owner": {"is_working": True, "start_time": "08:00", "end_time": "16:00"},
        "hourly_wage_krw": 10320,
        "business_date": "2026-11-20",
    }
    response = client.post("/tools/simulation/daily-roster", json=body, headers={"X-Request-Key": "r:roster"})
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["model_version"] == "operation.daily_roster.v1"
    assert data["scenario"]["start"] == "08:00" and data["cost"]["cash_cost_krw"] > 0
    bad = client.post(
        "/tools/simulation/daily-roster",
        json={**body, "owner": {"is_working": True, "start_time": "07:00"}},
        headers={"X-Request-Key": "r2:roster"},
    )
    assert bad.status_code == 400


def test_empty_store_periods_are_reported():
    result = plan({**BASE, "scenario": {"daily_orders": 60}, "owner": {"is_working": False}}, engine="reference")
    for period in result["empty_periods"]:
        assert _on_duty(result, period["start_time"]) == 0
    # 근무표 구간 중 아무도 없는 구간과 같다
    assert result["empty_periods"] == [
        {"start_time": c["start_time"], "end_time": c["end_time"]} for c in result["coverage"] if c["on_duty"] == 0
    ]
    kinds = {s["kind"] for s in result["shifts"]}
    assert kinds <= {"LONG", "SHORT"}
    for s in result["shifts"]:
        hours = (_minutes(s["end_time"]) - _minutes(s["start_time"])) / 60
        assert (s["kind"] == "LONG") == (hours >= 6)


def test_staff_curve_shows_waits_shrinking_with_more_people():
    result = plan(
        {**BASE, "scenario": {"orders_by_slot": HOURLY}, "owner": {"is_working": True}, "roster_rules": {"max_staff": 5}},
        engine="reference",
        include_curve=True,
    )
    curve = result["staff_curve"]
    assert [c["staff"] for c in curve] == [1, 2, 3, 4, 5]
    waits = [c["day_p90_sec"] for c in curve]
    assert waits[0] > waits[1] >= waits[-1] * 0.98  # 사람이 늘면 줄고, 어느 순간부터는 거의 그대로
    assert len(curve[0]["by_slot"]) == len(HOURLY)


def test_machine_counts_and_wait_target_are_used():
    body = {
        **BASE,
        "repetitions": 6,
        "scenario": {"orders_by_slot": {k: v * 2 for k, v in HOURLY.items()}},
        "owner": {"is_working": True},
        "roster_rules": {"max_staff": 4},
    }
    strict = plan({**body, "quality_targets": {"max_p90_post_order_receipt_sec": 180}}, engine="reference")
    loose = plan(body, engine="reference", include_curve=True)
    assert sum(r["required_staff"] for r in strict["required_by_slot"]) >= sum(
        r["required_staff"] for r in loose["required_by_slot"]
    )
    two = plan({**body, "equipment_counts": {"espresso": 2, "steam": 2, "blender": 1}}, engine="reference", include_curve=True)
    assert two["staff_curve"][-1]["day_p90_sec"] <= loose["staff_curve"][-1]["day_p90_sec"]


def test_시간대_판정을_1시간_전부터_돌려도_처음부터_돌린_것과_같다(monkeypatch):
    """속도 개선(SLOT_WARMUP_SEC) 회귀 검사: 아침·점심이 모두 붐비는 날에도 고르는 인원·근무조가 같다."""
    from app.tools.simulation import daily_roster

    hours = [10, 34, 38, 30, 22, 36, 30, 12, 11, 10, 8, 6, 4]
    body = {
        "scenario": {
            "orders_by_slot": {f"{h:02d}:00-{h + 1:02d}:00": n for h, n in zip(range(7, 20), hours)},
            "peak_start_time": "08:00",
            "peak_end_time": "11:00",
        },
        "repetitions": 12,
        "hourly_wage_krw": 10320,
        "business_date": "2026-11-20",
        "owner": {"is_working": True, "start_time": "07:00", "end_time": "15:00"},
    }
    fast = daily_roster.plan(body, engine="reference")
    monkeypatch.setattr(daily_roster, "SLOT_WARMUP_SEC", 24 * 3600)  # 처음부터 돌리기
    full = daily_roster.plan(body, engine="reference")
    pick = lambda r: (  # noqa: E731
        [x["required_staff"] for x in r["required_by_slot"]],
        r["required_fixes"],
        [(s["start_time"], s["end_time"]) for s in r["shifts"]],
    )
    assert pick(fast) == pick(full)
