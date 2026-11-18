"""URQ-SIM-011 상식 검증: 도착 수 = 완료 수, 직원을 늘리면 대기 감소, 화면 숫자 = 로그 숫자, 리틀 법칙, Erlang C 비교.

모두 참조 엔진으로 돌린다. 같은 시드라 결과가 매번 같다.
"""

import math
import random
import statistics

import pytest

from app.tools.simulation.simulation_common import _validate
from app.tools.simulation.trace_log import build_payload, write_traces
from app.tools.simulation.day_simulation import DayCafe, roster, roster_for_base
from app.tools.simulation.simulation_service import compare


@pytest.fixture(scope="module")
def day():
    return compare(
        {
            "scenario": {"daily_orders": 200},
            "repetitions": 10,
            "include_events": True,
            "random_seed": 7,
        },
        engine="reference",
    )


def _plan(data, key):
    return next(p for p in data["results"] if p["choice_key"] == key)


def _sojourns(events):
    arrived, done = {}, {}
    for e in events:
        if e["event_type"] == "arrival":
            arrived[e["order_id"]] = e["time_sec"]
        elif e["event_type"] == "completed":
            done[e["order_id"]] = e["time_sec"]
    return arrived, done


# 1. 도착 수 = 완료 수
def test_every_arrival_is_completed(day):
    for plan in day["results"]:
        for run in plan["per_run"]:
            assert run["arrived_orders"] > 0
        assert (
            plan["metrics"]["completed_eventually"]["mean"]
            == plan["metrics"]["arrived_orders"]["mean"]
        )
        arrived, done = _sojourns(plan["first_run_events"])
        assert (
            set(arrived) == set(done)
            and len(arrived) == plan["per_run"][0]["arrived_orders"]
        )


# 2. 직원을 늘리면 대기 감소
def test_more_staff_means_shorter_waits(day):
    current, extra = _plan(day, "CURRENT"), _plan(day, "ALT_C")
    assert (
        extra["metrics"]["avg_post_order_receipt_sec"]["mean"]
        < current["metrics"]["avg_post_order_receipt_sec"]["mean"]
    )
    assert (
        extra["comparison_to_current"]["avg_post_order_receipt_sec"]["verdict"]
        == "better"
    )
    slot = day["results"][0]["by_slot"][1]["slot"]
    assert slot == "11:00-14:00"
    assert (
        extra["by_slot"][1]["metrics"]["p90_post_order_receipt_sec"]["mean"]
        < current["by_slot"][1]["metrics"]["p90_post_order_receipt_sec"]["mean"]
    )


# 3. 화면 숫자 = 로그 숫자: 재생 기록으로 다시 잰 값이 결과 지표와 같다.
def test_replay_log_reproduces_reported_numbers(day):
    for plan in day["results"]:
        payload = build_payload(plan, day["repetitions"])
        assert payload["event_count"] == len(payload["events"])
        assert [e["sequence_no"] for e in payload["events"]] == list(
            range(1, payload["event_count"] + 1)
        )
        # 재생 기록(Spring 형식 v2)의 도착(ARRIVED)·받음(HANDED_OVER)으로 다시 잰다.
        arrived = {
            e["customer_key"]: e["at_seconds"]
            for e in payload["events"]
            if e["event_type"] == "ARRIVED"
        }
        done = {
            e["customer_key"]: e["at_seconds"]
            for e in payload["events"]
            if e["event_type"] == "HANDED_OVER"
        }
        assert set(arrived) == set(done)
        total = statistics.mean(done[k] - arrived[k] for k in arrived)
        assert total == pytest.approx(
            plan["per_run"][0]["avg_total_time_sec"], abs=0.01
        )


# 4. 리틀 법칙: 시간 평균 체류 인원 L = 도착률 λ × 평균 체류 시간 W
def test_littles_law_on_the_event_log(day):
    events = _plan(day, "CURRENT")["first_run_events"]
    arrived, done = _sojourns(events)
    start, end = min(arrived.values()), max(done.values())
    changes = sorted(
        [(t, 1) for t in arrived.values()] + [(t, -1) for t in done.values()]
    )
    area, count, last = 0.0, 0, start
    for t, delta in changes:
        area += count * (t - last)
        count, last = count + delta, t
    span = end - start
    lam = len(arrived) / span
    w = statistics.mean(done[k] - arrived[k] for k in arrived)
    assert area / span == pytest.approx(lam * w, rel=1e-9)


# 5. Erlang C 비교: 제조만 있는 M/M/c 상황에서 이론 대기와 맞는다.
def _erlang_c_wait(lam, mu, c):
    a = lam / mu
    head = sum(a**k / math.factorial(k) for k in range(c))
    tail = a**c / math.factorial(c) / (1 - a / c)
    return tail / (head + tail) / (c * mu - lam)


def _mmc_preparation_wait(plan, lam, mean_service, reps=30):
    _, _, conf = _validate(
        {"order_time_sec": 1, "handoff_time_sec": 1, "repetitions": 1}
    )
    conf = {**conf, "order_stddev_sec": 0, "handoff_stddev_sec": 0}
    rows = roster("four", [plan] * 4)
    waits = []
    for rep in range(reps):
        rng = random.Random(1000 + rep)
        t, orders = 0.0, []
        while True:
            t += rng.expovariate(lam)
            if t >= 12 * 3600:
                break
            orders.append(
                {
                    "arrival_sec": t,
                    "order_type": "dine_in",
                    "origin_slot": "07:00-11:00",
                    "standard_normal_draws": {
                        "order": 0.0,
                        "preparation": 0.0,
                        "handoff": 0.0,
                    },
                    "order_id": f"O{len(orders)}",
                    "menu_id": "iced_americano",
                    "prepared_steps": [
                        {
                            "name": "make",
                            "worker": True,
                            "equipment": None,
                            "seconds": rng.expovariate(1 / mean_service),
                        }
                    ],
                }
            )
        record = DayCafe(orders, rows, conf, plan, "reference", False).simulate()
        waits.append(record["stage_queue_wait_sec"]["preparation"])
    return statistics.mean(waits)


@pytest.mark.parametrize(
    "plan,servers,lam", [("CURRENT", 1, 1 / 100), ("ALT_C", 2, 1 / 50)]
)
def test_preparation_queue_matches_erlang_c(plan, servers, lam):
    simulated = _mmc_preparation_wait(plan, lam, 60)
    assert simulated == pytest.approx(_erlang_c_wait(lam, 1 / 60, servers), rel=0.10)


# 팀 결정(11.11): 세 안 비교에서 A·C는 11~14시에만, 나머지는 CURRENT
def test_three_plan_comparison_changes_only_lunch():
    for pid in ("ALT_A", "ALT_C"):
        assert [r["plan_id"] for r in roster_for_base(pid)] == [
            "CURRENT",
            pid,
            "CURRENT",
        ]
    assert {r["plan_id"] for r in roster_for_base("CURRENT")} == {"CURRENT"}


def test_trace_write_is_best_effort_without_database(day):
    refs = write_traces(
        day, session_id=1, input_version_id=2, result_id=3, request_key="k"
    )
    assert refs == []  # DB가 없으면 기록을 건너뛰고 계산 결과는 그대로 둔다
