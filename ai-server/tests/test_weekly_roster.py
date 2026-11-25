"""일주일 근무표(weekly_roster): 요일별 근무조 → 명단 배정, 주 15시간 미만 / 주휴 포함 비교."""

import pytest

from app.tools.simulation.weekly_roster import plan

WEEKDAYS = ("MON", "TUE", "WED", "THU", "FRI")


def _days(shifts_per_day):
    return [{"day": d, "shifts": shifts} for d, shifts in shifts_per_day.items()]


def _shift(a, b, rest=None):
    return {"start_time": a, "end_time": b, "breaks": [{"start_time": r[0], "end_time": r[1]} for r in (rest or [])]}


def _worker(key, days, span=("07:00", "20:00"), cap=40, minor=False, wage=10320):
    return {"worker_key": key, "hourly_wage_krw": wage, "is_minor": minor,
            "available": {d: list(span) for d in days}, "max_weekly_hours": cap}


DAYS = _days({d: [_shift("07:00", "11:00", [("09:00", "09:30")]), _shift("11:00", "15:00", [("13:30", "14:00")])] for d in WEEKDAYS})
TEAM = [_worker(k, WEEKDAYS) for k in ("A", "B", "C", "D")]


def test_compare_spreads_under_15h_or_packs_with_holiday_pay():
    data = plan({"days": DAYS, "workers": TEAM, "weekly_mode": "COMPARE"})
    under, holiday = data["results"]
    assert under["mode"] == "UNDER_15H" and holiday["mode"] == "WITH_HOLIDAY_PAY"
    assert not under["unfilled"] and not holiday["unfilled"]
    assert all(w["weekly_work_hours"] < 15 for w in under["workers"])
    assert under["holiday_pay_krw"] == 0
    assert holiday["people_used"] < under["people_used"]
    assert holiday["holiday_pay_krw"] > 0
    # 같은 자리, 같은 시급 → 기본급은 같고 차이는 주휴수당
    base = lambda r: sum(w["base_wage_krw"] for w in r["workers"])  # noqa: E731
    assert base(under) == base(holiday)
    assert holiday["weekly_cost_krw"] - under["weekly_cost_krw"] == holiday["holiday_pay_krw"]


def test_holiday_pay_formula_matches_labor():
    data = plan({"days": _days({d: [_shift("09:00", "13:00")] for d in WEEKDAYS}), "workers": [_worker("A", WEEKDAYS)],
                 "weekly_mode": "WITH_HOLIDAY_PAY"})
    worker = data["results"][0]["workers"][0]
    assert worker["weekly_work_hours"] == 20
    assert worker["holiday_pay_krw"] == round(20 / 40 * 8 * 10320)  # 41,280원
    assert worker["base_wage_krw"] == 20 * 10320


def test_one_shift_a_day_availability_and_unfilled_slots_are_kept():
    days = _days({"MON": [_shift("07:00", "11:00"), _shift("15:00", "19:00")]})
    only_morning = [_worker("A", ["MON"], span=("07:00", "12:00"))]
    result = plan({"days": days, "workers": only_morning, "weekly_mode": "WITH_HOLIDAY_PAY"})["results"][0]
    assert [a["start_time"] for a in result["assignments"]] == ["07:00"]
    assert [u["start_time"] for u in result["unfilled"]] == ["15:00"]


def test_minor_limits_daily_weekly_and_night():
    days = _days({"MON": [_shift("07:00", "15:00", [("11:00", "11:30")])], "TUE": [_shift("18:00", "23:00", [("20:00", "20:30")])]})
    result = plan({"days": days, "workers": [_worker("M", ["MON", "TUE"], span=("06:00", "23:30"), minor=True)],
                   "weekly_mode": "WITH_HOLIDAY_PAY"})["results"][0]
    # 월: 실제 7.5시간 > 7시간, 화: 22시 넘음 → 둘 다 못 넣는다
    assert result["assignments"] == [] and len(result["unfilled"]) == 2


def test_caps_are_respected():
    result = plan({"days": DAYS, "workers": [_worker("A", WEEKDAYS, cap=10), _worker("B", WEEKDAYS, cap=10)],
                   "weekly_mode": "WITH_HOLIDAY_PAY"})["results"][0]
    assert all(w["weekly_work_hours"] <= 10 for w in result["workers"])
    assert result["unfilled"]


@pytest.mark.parametrize("bad", [
    {"days": [{"day": "XXX", "shifts": []}], "workers": TEAM},
    {"days": DAYS, "workers": [{"worker_key": "A", "hourly_wage_krw": 0}]},
    {"days": DAYS, "workers": TEAM, "weekly_mode": "ALL"},
])
def test_rejects_bad_input(bad):
    with pytest.raises(ValueError):
        plan(bad)


def test_router_weekly_roster():
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = fastapi.FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    client = TestClient(app)
    ok = client.post("/tools/simulation/weekly-roster", json={"days": DAYS, "workers": TEAM}, headers={"X-Request-Key": "w"})
    assert ok.status_code == 200 and len(ok.json()["data"]["results"]) == 2
    bad = client.post("/tools/simulation/weekly-roster", json={"days": DAYS, "workers": [{"worker_key": "A"}]})
    assert bad.status_code == 400


def test_assignment_fills_as_many_hours_as_any_assignment_could():
    """작은 경우를 모두 따져 본 최선과 같다(정해진 순서로 채우면 놓칠 수 있는 교환도 찾는다)."""
    import itertools
    import random

    from app.tools.simulation.weekly_roster import _eligible, _slots, _workers, assign

    rng = random.Random(7)
    for case in range(25):
        days = {}
        for d in rng.sample(WEEKDAYS, 3):
            starts = sorted(rng.sample([7, 9, 11, 13, 15], 2))
            days[d] = [_shift(f"{h:02d}:00", f"{h + rng.choice([3, 4, 5]):02d}:00") for h in starts]
        team = [
            _worker(k, rng.sample(WEEKDAYS, rng.randint(1, 3)), span=rng.choice([("07:00", "13:00"), ("09:00", "21:00"), ("07:00", "21:00")]),
                    cap=rng.choice([6, 9, 14, 40]))
            for k in "ABC"
        ]
        for mode in ("UNDER_15H", "WITH_HOLIDAY_PAY"):
            slots, workers = _slots(_days(days)), _workers(team)
            got = assign(slots, workers, mode)
            filled = sum(a["work_hours"] for a in got["assignments"])
            best = 0
            for choice in itertools.product([None, *range(len(workers))], repeat=len(slots)):
                week, seen, ok = [0] * len(workers), set(), True
                for slot, wi in zip(slots, choice):
                    if wi is None:
                        continue
                    w = workers[wi]
                    if not _eligible(w, slot, mode) or (wi, slot["day"]) in seen:
                        ok = False
                        break
                    seen.add((wi, slot["day"]))
                    week[wi] += slot["work_min"]
                cap_ok = all(
                    week[i] <= min(workers[i]["cap_min"], 899 if mode == "UNDER_15H" else 10**9) for i in range(len(workers))
                )
                if ok and cap_ok:
                    best = max(best, sum(s["work_min"] for s, wi in zip(slots, choice) if wi is not None) / 60)
            assert filled == pytest.approx(best), (case, mode)
            assert got["optimal"] is True


def test_휴게는_근무_안쪽만_겹침_없이_뺀다():
    from app.tools.simulation.weekly_roster import _rest_minutes

    t = lambda a, b: {"start_time": a, "end_time": b}  # noqa: E731
    start, end = 9 * 60, 15 * 60
    assert _rest_minutes(start, end, [t("12:00", "12:30")]) == 30
    assert _rest_minutes(start, end, [t("12:00", "12:30"), t("12:15", "12:45")]) == 45  # 겹침은 한 번
    assert _rest_minutes(start, end, [t("08:30", "09:30"), t("14:45", "16:00")]) == 45  # 근무 밖은 잘라 냄
    assert _rest_minutes(start, end, []) == 0
