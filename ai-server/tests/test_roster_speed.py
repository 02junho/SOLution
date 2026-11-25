"""추천 근무표 속도: 주휴 비교 끄기(B), 요일 기억(D), 계산 중 이어받기(E), 시급 분리(F), 미리 계산 우선순위."""

import copy

import pytest

from app.tools.simulation import day_cache
from app.tools.simulation import roster_options as ro
from tests.test_roster_options import WORKERS, _day

BUSY = [18, 22, 20, 10, 24, 26, 22, 7, 6, 7, 2, 1, 2]
QUIET = [6, 6, 6, 6, 12, 12, 10, 4, 4, 4, 2, 1, 1]


@pytest.fixture(autouse=True)
def fresh_cache(monkeypatch):
    monkeypatch.setenv("ROSTER_DAY_CACHE", "50")
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "1")  # 세기 쉽게 한 프로세스에서
    day_cache.clear()
    yield
    day_cache.clear()


@pytest.fixture
def calls(monkeypatch):
    """실제로 계산한 요일 수를 센다."""
    seen = []
    real = ro.day_options

    def counted(body, engine="simpy", min_gain=ro.MIN_GAIN_SEC, holiday=True):
        seen.append(body["scenario"]["orders_by_slot"]["11:00-12:00"])
        return real(body, engine, min_gain, holiday)

    monkeypatch.setattr(ro, "day_options", counted)
    return seen


def test_주휴_비교를_끄면_비교가_없고_세_안은_같다():
    on = ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS})
    day_cache.clear()
    off = ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS, "compare_holiday_pay": False})
    assert off["holiday_compare"] is None
    assert on["holiday_compare"]["key"] == "RECOMMENDED"
    # 주휴 비교만 빠지고 세 안 결과는 그대로
    assert on["options"] == off["options"]
    assert on["days"] == off["days"]
    assert not any("주휴를 주는 경우" in a for a in off["assumptions"])
    assert off["repetitions"] == on["repetitions"] == 8


def test_주휴_비교_값_검사():
    with pytest.raises(ValueError):
        ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS, "compare_holiday_pay": "no"})


def test_같은_조건은_다시_계산하지_않는다(calls):
    body = {"days": [_day("MON", BUSY), _day("TUE", QUIET)], "workers": WORKERS}
    first = ro.plan(body)
    assert len(calls) == 2
    again = ro.plan(body)
    assert len(calls) == 2  # 두 요일 모두 기억에서
    assert first == again


def test_한_요일만_바꾸면_그_요일만_계산한다(calls):
    ro.plan({"days": [_day("MON", BUSY), _day("TUE", QUIET)], "workers": WORKERS})
    changed = [*QUIET]
    changed[4] = 20  # 화요일 11시 주문만 바꿈
    ro.plan({"days": [_day("MON", BUSY), _day("TUE", changed)], "workers": WORKERS})
    assert calls == [BUSY[4], QUIET[4], 20]


def test_직원_명단만_바꾸면_요일은_다시_계산하지_않는다(calls):
    ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS})
    ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS[:3]})
    assert len(calls) == 1


def test_기준값이나_주휴_비교가_다르면_따로_계산한다(calls):
    ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS})
    ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS, "min_gain_sec": 60})
    ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS, "compare_holiday_pay": False})
    assert len(calls) == 3


def test_조건이_같은_요일은_한_번만_계산한다(calls):
    out = ro.plan({"days": [_day("MON", BUSY), _day("TUE", BUSY)], "workers": WORKERS})
    assert len(calls) == 1
    assert out["days"]["MON"] == out["days"]["TUE"]


def test_꺼낸_결과를_고쳐도_기억은_그대로():
    out = ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS})
    out["days"]["MON"]["picks"]["RECOMMENDED"] = 99
    again = ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS})
    assert again["days"]["MON"]["picks"]["RECOMMENDED"] != 99


def test_기억_상한을_넘으면_오래된_것부터_지운다(monkeypatch):
    monkeypatch.setenv("ROSTER_DAY_CACHE", "2")
    for i in range(3):
        day_cache.put(f"k{i}", {"i": i})
    assert day_cache.count() == 2
    assert day_cache.get("k0") is None
    assert day_cache.get("k2") == {"i": 2}


def test_상한_0이면_기억하지_않는다(monkeypatch, calls):
    monkeypatch.setenv("ROSTER_DAY_CACHE", "0")
    body = {"days": [_day("MON", BUSY)], "workers": WORKERS}
    ro.plan(body)
    ro.plan(body)
    assert len(calls) == 2
    assert day_cache.count() == 0


def test_키는_조건_순서와_상관없다():
    assert day_cache.key({"a": 1, "b": 2}) == day_cache.key({"b": 2, "a": 1})
    assert day_cache.key({"a": 1}) != day_cache.key({"a": 2})


def test_계산_중인_요일은_이어받는다(monkeypatch):
    """미리 계산이 돌고 있는 요일을 진짜 계산이 새로 돌리지 않고 기다려 받는다."""
    import threading

    started, release = threading.Event(), threading.Event()
    seen = []
    real = ro.day_options

    def slow(body, engine="simpy", min_gain=ro.MIN_GAIN_SEC, holiday=True):
        seen.append(threading.current_thread().name)
        started.set()
        release.wait(30)
        return real(body, engine, min_gain, holiday)

    monkeypatch.setattr(ro, "day_options", slow)
    body = {"days": [_day("MON", BUSY)], "workers": WORKERS, "compare_holiday_pay": False}
    out = {}
    warm = threading.Thread(target=lambda: out.setdefault("warm", ro.plan(body)), name="warm")
    warm.start()
    assert started.wait(30)
    real_run = threading.Thread(target=lambda: out.setdefault("real", ro.plan(body)), name="real")
    real_run.start()
    # 진짜 계산은 같은 요일을 기다리는 중(새로 돌리지 않음)
    real_run.join(0.5)
    assert real_run.is_alive() and day_cache.running() == 1
    release.set()
    warm.join(60)
    real_run.join(60)
    assert seen == ["warm"]
    assert out["warm"] == out["real"]
    assert day_cache.running() == 0


def test_먼저_계산하던_쪽이_실패하면_이어받던_쪽이_직접_계산한다(calls):
    import threading

    body = {"days": [_day("MON", BUSY)], "workers": WORKERS, "compare_holiday_pay": False}
    k = ro._job_key(("MON", body["days"][0]["roster"], "simpy", ro.MIN_GAIN_SEC, False))
    claimed, future = day_cache.claim(k)  # 다른 요청이 계산 중인 척
    assert claimed
    out = {}
    waiter = threading.Thread(target=lambda: out.setdefault("plan", ro.plan(body)))
    waiter.start()
    waiter.join(0.5)
    assert waiter.is_alive() and calls == []  # 기다리는 중
    day_cache.release(k, future, error=RuntimeError("프로세스 오류"))
    waiter.join(60)
    assert len(calls) == 1 and out["plan"]["options"]
    assert day_cache.running() == 0


def _with_wage(day, wage):
    out = copy.deepcopy(day)
    out["roster"]["hourly_wage_krw"] = wage
    return out


@pytest.mark.parametrize("values", [BUSY, QUIET])
def test_시급만_바꾸면_다시_안_돌리고_처음부터_계산한_것과_똑같다(calls, values):
    """F: 시급은 인건비에만 들어간다. 기억한 근무표에 인건비만 다시 계산한 결과 = 그 시급으로 처음부터 계산한 결과."""
    low = {"days": [_with_wage(_day("MON", values), 10320)], "workers": WORKERS, "compare_holiday_pay": True}
    high = {"days": [_with_wage(_day("MON", values), 12500)], "workers": WORKERS, "compare_holiday_pay": True}
    ro.plan(low)
    from_memory = ro.plan(high)
    assert len(calls) == 1  # 두 번째는 시뮬레이션 안 돌림
    day_cache.clear()
    fresh = ro.plan(high)
    assert len(calls) == 2
    assert from_memory == fresh
    # 인건비는 실제로 바뀌었다
    assert from_memory["options"][0]["plan_cost_krw"] != ro.plan(low)["options"][0]["plan_cost_krw"]


def test_최저시급보다_낮은_시급은_기억이_있어도_막는다(calls):
    ro.plan({"days": [_day("MON", BUSY)], "workers": WORKERS})
    out = ro.plan({"days": [_with_wage(_day("MON", BUSY), 5000)], "workers": WORKERS})
    day_cache.clear()
    fresh = ro.plan({"days": [_with_wage(_day("MON", BUSY), 5000)], "workers": WORKERS})
    assert out["skipped_days"] and out["skipped_days"][0]["day"] == "MON"
    assert fresh["skipped_days"] and fresh["skipped_days"][0]["day"] == "MON"


def test_미리_계산은_결과가_같고_값을_검사한다():
    body = {"days": [_day("MON", QUIET)], "workers": WORKERS, "compare_holiday_pay": False}
    normal = ro.plan(body)
    day_cache.clear()
    background = ro.plan({**body, "background": True})  # 낮은 우선순위 프로세스로
    assert normal == background
    with pytest.raises(ValueError):
        ro.plan({**body, "background": "yes"})


def test_진행_상황은_끝난_요일_요약을_모은다():
    from app.tools.simulation import roster_options as ro

    entry = ro._progress_start("k1", ["MON", "TUE"])
    assert ro.progress("k1") == {"total": 2, "done": 0, "order": ["MON", "TUE"], "days": {}}
    day = {"picks": {"RECOMMENDED": 1}, "windows": [{"start_time": "11:00", "end_time": "14:00"}],
           "ladder": [{"peak_wait_sec": 200}, {"peak_wait_sec": 150}]}
    ro._progress_day(entry, "TUE", day, None)
    ro._progress_day(entry, "MON", None, "주문이 없어요")
    out = ro.progress("k1")
    assert out["done"] == 2 and list(out["days"]) == ["MON", "TUE"]  # 요일 순서대로
    assert out["days"]["TUE"] == {"windows": day["windows"], "extra": 1, "peak_wait_sec": 150}
    assert out["days"]["MON"] == {"failed": True}
    assert ro.progress("없는키") is None
    assert ro._progress_start(None, ["MON"]) is None  # 키가 없으면 아무것도 안 남긴다
    # 같은 키로 다시 계산하면 새 기록: 앞 실행이 아직 못 끝낸 요일을 늦게 끝내도 새 기록에 섞이지 않는다
    old = ro._progress_start("k1", ["MON", "TUE"])
    ro._progress_day(old, "TUE", day, None)  # 앞 실행은 TUE만 끝낸 상태
    again = ro._progress_start("k1", ["MON", "TUE"])
    ro._progress_day(old, "MON", day, None)  # 앞 실행이 MON을 늦게 끝냄 → 자기 기록에만
    assert ro.progress("k1")["done"] == 0
    assert "MON" in old["days"]
    ro._progress_day(again, "MON", day, None)  # 새 실행이 MON을 끝낼 때만 늘어난다
    assert ro.progress("k1")["done"] == 1


def test_계산하면서_진행_상황을_남긴다(calls):
    out = ro.plan({"days": [_day("MON", BUSY), _day("TUE", QUIET)], "workers": WORKERS, "progress_key": "job-1"})
    seen = ro.progress("job-1")
    assert seen["total"] == 2 and seen["done"] == 2
    assert seen["days"]["MON"]["extra"] == out["options"][1]["extra_by_day"]["MON"]  # 추천안과 같은 값
    ro.plan({"days": [_day("MON", BUSY), _day("TUE", QUIET)], "workers": WORKERS, "progress_key": "job-2"})
    assert ro.progress("job-2")["done"] == 2  # 기억에서 꺼낸 요일도 끝난 것으로 센다


def test_이어받은_요일은_끝나는_대로_진행에_잡힌다(monkeypatch):
    """미리 계산이 돌던 요일을 진짜 계산이 이어받을 때, 미리 계산이 요일 하나를 끝내면 바로 진행 표시에 나와야 한다."""
    import threading, time as _time

    from app.tools.simulation import roster_options as ro2

    real = ro2._day_job
    gate = threading.Event()

    def slow(args):
        if args[0] == "TUE":
            gate.wait()  # 화요일만 붙잡아 둔다(테스트가 직접 풀 때까지)
        return real(args)

    monkeypatch.setattr(ro2, "_day_job", slow)
    monkeypatch.setattr(ro2, "worker_count", lambda n: 1)  # 같은 프로세스에서 차례로(_day_job 바꾼 것이 먹게)
    body = {"days": [_day("MON", BUSY), _day("TUE", QUIET)], "workers": WORKERS}
    warm = threading.Thread(target=lambda: ro2.plan({**body, "background": False}))
    warm.start()
    _time.sleep(0.2)
    seen = {}
    job = threading.Thread(target=lambda: seen.update(out=ro2.plan({**body, "progress_key": "follow"})))
    job.start()
    try:
        deadline = _time.time() + 20
        while _time.time() < deadline and (ro2.progress("follow") or {}).get("done", 0) < 1:
            _time.sleep(0.05)
        assert ro2.progress("follow")["done"] == 1  # 월요일은 화요일을 기다리지 않고 잡힘
    finally:
        gate.set()  # 확인이 실패해도 붙잡힌 계산을 풀어 스레드가 끝나게
        warm.join(20)
        job.join(20)
    assert ro2.progress("follow")["done"] == 2
