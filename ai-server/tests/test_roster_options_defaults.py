"""추천 근무표 API 기본값과 기존 운영 1번·실험 API를 분리한다."""
from app.schemas.simulation import CompareRequest, DailyRosterRequest, RosterOptionsRequest, WeekPlanRequest


def request(reps=None):
    roster = {"scenario": {"daily_orders": 100}, "hourly_wage_krw": 10320}
    if reps is not None:
        roster["repetitions"] = reps
    return {"days": [{"day": "MON", "roster": roster}], "workers": [{}]}


def test_roster_options_defaults_to_twenty():
    for background in (False, True):
        body = RosterOptionsRequest.model_validate({**request(), "background": background})
        assert body.model_dump(exclude_none=True)["days"][0]["roster"]["repetitions"] == 20


def test_explicit_repetitions_and_other_endpoints_remain_unchanged():
    assert RosterOptionsRequest.model_validate(request(8)).days[0].roster.repetitions == 8
    assert CompareRequest().repetitions == 30
    assert DailyRosterRequest(hourly_wage_krw=10320).repetitions == 30
    assert WeekPlanRequest.model_validate(request()).days[0].roster.repetitions == 30


def test_reference_day_cache_recalculates_only_changed_day(monkeypatch):
    from app.tools.simulation import roster_options as ro, day_cache
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "1")
    monkeypatch.setenv("ROSTER_DAY_CACHE", "50")
    day_cache.clear()
    rows = request()["days"]
    rows[0]["roster"]["scenario"] = {"daily_orders": 60}
    rows[0]["roster"]["business_date"] = "2026-11-24"
    first = RosterOptionsRequest.model_validate({"days": rows, "workers": [{}]})
    raw = first.model_dump(exclude_none=True)["days"][0]["roster"]
    # 첫 실행은 20회, 같은 입력은 캐시, 사장님 조건을 바꾸면 새 키로 계산한다.
    job = ("MON", raw, "reference", 30, False)
    changed = ("MON", {**raw, "owner": {"is_working": True, "start_time": "07:00", "end_time": "15:00"}}, "reference", 30, False)
    try:
        a = ro._run_days([job])
        assert a[0][2] is None
        assert all(v["repetitions"] == 20 for v in a[0][1]["rosters"].values())
        assert ro._run_days([job]) == a
        assert day_cache.count() == 1
        b = ro._run_days([changed])
        assert b[0][2] is None and day_cache.count() == 2
        assert ro._run_days([job]) == a
    finally:
        day_cache.clear()
