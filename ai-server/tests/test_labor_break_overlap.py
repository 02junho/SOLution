"""휴게 겹침 방지: 같은 안에서 두 사람이 같은 시간에 쉬어 매장이 비지 않게 한다."""
from app.schemas.labor import ScheduleRequest
from app.tools.labor import schedule


def _request(owner_works: bool):
    workers = [{"worker_key": "STAFF_1", "is_owner": False, "is_minor": False, "hourly_wage_krw": 10320},
               {"worker_key": "STAFF_2", "is_owner": False, "is_minor": False, "hourly_wage_krw": 10320}]
    if owner_works:
        workers[0] = {"worker_key": "OWNER", "is_owner": True, "is_minor": None, "hourly_wage_krw": None}
    lead = workers[0]["worker_key"]
    shifts = [{"worker_key": lead, "start_time": "07:00", "end_time": "19:00", "task_code": "ORDER_HANDOFF"},
              {"worker_key": "STAFF_2", "start_time": "07:00", "end_time": "19:00", "task_code": "PREPARATION"}]
    plans = [{"choice_key": key, "shifts": shifts} for key in ("CURRENT", "ALT_A", "ALT_C")]
    return ScheduleRequest(session_id=1, input_version_id=2, business_date="2026-11-18", workers=workers, plans=plans,
                           avoid_break_windows=[{"start_time": "11:00", "end_time": "14:00"}])


def _breaks(result, choice):
    plan = next(p for p in result.data["plans"] if p["choice_key"] == choice)
    return {s["worker_key"]: [(b["start_time"], b["end_time"]) for b in s["breaks"]] for s in plan["schedule"]}


def test_two_staff_do_not_take_breaks_at_the_same_time():
    result = schedule.run(_request(owner_works=False))
    assert result.status == "ok"
    breaks = _breaks(result, "CURRENT")
    (a_start, a_end), = breaks["STAFF_1"]
    (b_start, b_end), = breaks["STAFF_2"]
    assert a_end <= b_start or b_end <= a_start


def test_breaks_still_avoid_the_rush_window():
    result = schedule.run(_request(owner_works=False))
    for rests in _breaks(result, "CURRENT").values():
        for start, end in rests:
            assert end <= "11:00" or start >= "14:00"


def test_owner_gets_no_break_and_staff_break_is_unchanged():
    result = schedule.run(_request(owner_works=True))
    breaks = _breaks(result, "CURRENT")
    assert breaks["OWNER"] == []
    assert len(breaks["STAFF_2"]) == 1
