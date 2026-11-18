"""받은 근무표 시뮬레이션 + Spring 운영 계약(v0.4) 응답.

Spring 검사(OperationResultContract.validateSimulation, FastApiSimulationService)를 파이썬으로 옮겨
엔진 응답이 Spring에서 계약 오류(502) 없이 통과하는지 확인한다. 기준 요청은 data/demo/operation의 예시다.
"""

import copy
import json
import math
from pathlib import Path

import pytest

from app.tools.simulation.day_simulation import roster_from_shifts
from app.tools.simulation.simulation_service import compare
from app.tools.simulation.spring_contract import ContractError, build
from app.tools.simulation.staffing_input import EMPLOYEE_SCHEMA_VERSION, parse

DEMO = Path(__file__).resolve().parents[2] / "data" / "demo" / "operation"
CHOICES = {"CURRENT", "ALT_A", "ALT_C"}
METRICS = [
    "order_queue_wait_mean_seconds",
    "post_order_wait_mean_seconds",
    "total_time_mean_seconds",
    "total_time_p90_seconds",
    "post_order_wait_over_300_ratio",
    "completed_customer_count_mean",
    "throughput_per_hour_mean",
]
NOT_FOR_ENGINE = {
    "plans",
    "choices",
    "staffing_schema_version",
    "request_key",
    "session_id",
    "input_version_id",
    "result_id",
}


def _request(name):
    return json.loads((DEMO / name).read_text(encoding="utf-8"))


def _run(request, daily_orders=None):
    """router.compare_plans와 같은 순서(근무표 해석 → 계산 → 계약 모양). 엔진만 참조 엔진으로 바꾼다."""
    body = copy.deepcopy(request)
    if daily_orders is not None:
        body["scenario"]["daily_orders"] = daily_orders
    staffing = parse(body)
    data = compare(
        {k: v for k, v in body.items() if k not in NOT_FOR_ENGINE},
        engine="reference",
        plan_rosters=staffing.rosters,
    )
    return build(data, staffing), staffing


# ---------------------------------------------------------------- Spring 검사 옮김
def _number(value):
    assert (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
    )
    return float(value)


def _plans(data):
    present = [k for k in ("choices", "plans", "results") if k in data]
    assert len(present) == 1
    rows = data[present[0]]
    assert len(rows) == 3 and {r["choice_key"] for r in rows} == CHOICES
    return rows


def _normalized_staffing(plans):
    out = []
    for plan in plans:
        shifts = []
        for row in plan["shifts"]:
            shift = {
                k: row[k] for k in ("worker_key", "start_time", "end_time", "task_code")
            }
            assert all(isinstance(v, str) for v in shift.values())
            if row.get("primary_role") is not None:
                shift["primary_role"] = row["primary_role"]
                shift["can_support"] = sorted(row.get("can_support") or [])
            shifts.append(shift)
        out.append(
            {
                "choice_key": plan["choice_key"],
                "shifts": sorted(
                    shifts, key=lambda s: s["worker_key"] + ":" + s["start_time"]
                ),
            }
        )
    return sorted(out, key=lambda p: p["choice_key"])


def spring_accepts(data):
    """OperationResultContract.validateSimulation + OperationResultService의 complete·경고 검사."""
    assert data["complete"] is True
    assert (
        _number(data["requested_repetitions"]) == 30
        and _number(data["completed_repetitions"]) == 30
    )
    assert isinstance(data["metric_definitions"], dict) and data["metric_definitions"]
    assert isinstance(data["statistics_policy_version"], str)
    assert isinstance(data["comparison_window"], dict)
    for plan in _plans(data):
        for metric in METRICS:
            value = _number(plan["metrics"][metric])
            assert value >= 0 and (not metric.endswith("_ratio") or value <= 1)
        if plan["choice_key"] != "CURRENT":
            c = plan["comparison"]
            assert c["metric"] in METRICS[:4]
            _number(c["delta_vs_current_seconds"])
            assert _number(c["ci95_lower_seconds"]) <= _number(c["ci95_upper_seconds"])
            assert c["paired_repetitions"] == 30 and 0 <= c["better_count"] <= 30
    assert "recommendation" in data
    if data["recommendation"] is not None:
        r = data["recommendation"]
        assert (
            r["choice_key"] in CHOICES
            and r["basis_metric"] in METRICS[:5]
            and r["reason"].strip()
        )
    reps = data["replication_metrics"]
    assert len(reps) == 30 and {r["replication_no"] for r in reps} == set(range(1, 31))
    for rep in reps:
        for plan in _plans(rep):
            for metric in METRICS:
                value = _number(plan["metrics"][metric])
                assert value >= 0 and (not metric.endswith("_ratio") or value <= 1)
    ids = set()
    for w in data["warnings"]:
        assert (
            isinstance(w["warning_id"], str)
            and w["warning_id"]
            and isinstance(w["message"], str)
        )
        assert isinstance(w["requires_ack"], bool) and w["warning_id"] not in ids
        ids.add(w["warning_id"])
    assert any(
        w["warning_id"] == "SIMULATED_CONDITIONS" and w["requires_ack"]
        for w in data["warnings"]
    )
    assert all(isinstance(a, str) for a in data["assumptions"])


# ---------------------------------------------------------------- 기존 형식(plans)
def test_spring_demo_request_passes_contract_and_echoes_same_plans():
    request = _request("simulation_request.json")
    data, _ = _run(request)
    spring_accepts(data)
    # Spring은 돌려받은 근무표가 입력 labor.plans와 같아야 인건비 계산으로 넘어간다.
    assert _normalized_staffing(data["staffing"]) == _normalized_staffing(
        request["plans"]
    )
    assert "choices" not in data and "staffing_schema_version" not in data


def test_received_plans_are_simulated_not_engine_presets():
    request = _request("simulation_request.json")
    _, staffing = _run(request)
    current = staffing.rosters["CURRENT"]
    # 예시: 사장님 혼자 07~10시, 직원 10시 출근 → 07~10시는 1명
    assert (
        current[0]["start"] == "07:00"
        and current[0]["end"] == "10:00"
        and current[0]["staff_count"] == 1
    )
    alt_c = staffing.rosters["ALT_C"]
    assert max(r["staff_count"] for r in alt_c) == 3


def test_more_staff_in_the_rush_does_not_make_waits_worse():
    data, _ = _run(_request("simulation_request.json"))
    by_key = {p["choice_key"]: p for p in data["results"]}
    assert (
        by_key["ALT_C"]["metrics"]["post_order_wait_mean_seconds"]
        <= by_key["CURRENT"]["metrics"]["post_order_wait_mean_seconds"]
    )


def test_engine_detail_stays_in_each_choice_for_the_screen():
    data, _ = _run(_request("simulation_request.json"))
    row = data["results"][0]
    assert len(row["by_slot"]) == 4 and "segments" in row["simulated_staffing"]
    assert row["simulated_staffing"]["breaks_included"] is False


def test_no_feasible_plan_becomes_reference_warning_not_fake_choice():
    data, _ = _run(_request("simulation_request.json"), daily_orders=400)
    if data["recommendation"] is None:
        assert any(
            w["warning_id"] == "NO_FEASIBLE_PLAN" and w["requires_ack"] is False
            for w in data["warnings"]
        )
    spring_accepts(data)


# ---------------------------------------------------------------- 직원별 형식(choices)
def test_employee_contract_returns_choices_with_same_employees():
    request = _request("staffing_proposal/simulation_request.json")
    data, _ = _run(request)
    spring_accepts(data)
    assert data["staffing_schema_version"] == EMPLOYEE_SCHEMA_VERSION
    assert "results" not in data and "staffing" not in data
    sent = {c["choice_key"]: c["staffing"]["employees"] for c in request["choices"]}
    for row in data["choices"]:
        got = row["staffing"]["employees"]
        assert [
            (e["staff_id"], e["primary_role"], e["start_time"], e["end_time"])
            for e in got
        ] == [
            (e["staff_id"], e["primary_role"], e["start_time"], e["end_time"])
            for e in sent[row["choice_key"]]
        ]


# ---------------------------------------------------------------- 입력 검사
def test_rejects_wrong_choice_set():
    request = _request("simulation_request.json")
    request["plans"] = request["plans"][:2]
    with pytest.raises(ValueError, match="세 안"):
        parse(request)


def test_rejects_unknown_task_code():
    request = _request("simulation_request.json")
    request["plans"][0]["shifts"][0]["task_code"] = "CLEANING"
    with pytest.raises(ValueError, match="업무 코드"):
        parse(request)


def test_someone_must_stay_until_close():
    shifts = [
        {
            "worker_key": "OWNER",
            "start_time": "07:00",
            "end_time": "18:00",
            "task_code": "ALL_TASKS",
        }
    ]
    with pytest.raises(ValueError, match="NEEDS_INPUT"):
        roster_from_shifts(shifts)


def test_overlapping_shifts_of_one_worker_are_rejected():
    shifts = [
        {
            "worker_key": "A",
            "start_time": "07:00",
            "end_time": "19:00",
            "task_code": "ALL_TASKS",
        },
        {
            "worker_key": "A",
            "start_time": "11:00",
            "end_time": "14:00",
            "task_code": "PREPARATION",
        },
    ]
    with pytest.raises(ValueError, match="겹칩니다"):
        roster_from_shifts(shifts)


def test_contract_needs_thirty_repetitions():
    request = _request("simulation_request.json")
    request["repetitions"] = 5
    with pytest.raises(ContractError, match="30회"):
        _run(request)


def test_breaks_in_plans_are_ignored_by_simulation():
    request = _request("simulation_request.json")
    with_break = copy.deepcopy(request)
    with_break["plans"][0]["shifts"][-1]["breaks"] = [
        {"start_time": "15:00", "end_time": "15:30", "is_paid": False}
    ]
    a, _ = _run(request)
    b, _ = _run(with_break)
    assert a["results"][0]["metrics"] == b["results"][0]["metrics"]


# ---------------------------------------------------------------- router (FastAPI가 있는 환경)
def test_router_answers_spring_demo_request_with_contract():
    fastapi = pytest.importorskip("fastapi")
    pytest.importorskip("simpy")
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = fastapi.FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    request = _request("simulation_request.json")
    request.pop("session_id")  # 테스트 DB에 실행 기록을 남기지 않는다
    request["scenario"]["daily_orders"] = 60
    response = TestClient(app).post(
        "/tools/simulation/compare",
        json=request,
        headers={"X-Request-Key": "run:simulation"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    spring_accepts(body["data"])
    assert (
        body["data"]["request_key"] == "run:simulation"
        and body["data"]["result_id"] == 7001
    )


# ---------------------------------------------------------------- 대기열 재생 기록 (operation.trace.v2)
from app.tools.simulation.trace_log import build_payload  # noqa: E402

EVENT_TYPES = {
    "ARRIVED",
    "ORDER_STARTED",
    "ORDER_COMPLETED",
    "PREPARATION_STARTED",
    "PREPARATION_COMPLETED",
    "HANDOFF_STARTED",
    "HANDED_OVER",
    "STAFF_ON",
    "STAFF_OFF",
}
STAGES = {
    "ORDER_QUEUE",
    "ORDERING",
    "WAITING_PREPARATION",
    "PREPARING",
    "WAITING_HANDOFF",
    "DONE",
}


def spring_reads_trace(payload, completed_repetitions=30):
    """OperationResultService.traceResponse·cleanInitialState 검사를 옮김."""
    import re

    assert payload["time_unit"] == "seconds"
    assert re.fullmatch(
        r"(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?", payload["time_origin"]
    )
    assert payload["choice_key"] in CHOICES
    assert 1 <= payload["replication_no"] <= completed_repetitions
    assert payload["trace_schema_version"] == "operation.trace.v2" and isinstance(
        payload["initial_state"], dict
    )
    assert isinstance(payload["is_complete"], bool)
    state = payload["initial_state"]
    for key in ("active_staff_keys", "order_queue", "preparation_queue"):
        assert all(isinstance(x, str) for x in state[key])
    assert state["completed_customer_count"] >= 0
    for group, field in (("customers", "state"), ("in_service", "stage")):
        for row in state.get(group, []):
            assert isinstance(row["customer_key"], str) and row[field] in STAGES
    seen = set()
    for e in payload["events"]:
        assert e["event_type"] in EVENT_TYPES and e["at_seconds"] >= 0
        assert e["sequence_no"] > 0 and e["sequence_no"] not in seen
        seen.add(e["sequence_no"])
    assert payload["event_count"] == len(payload["events"])


def replay_end(payload):
    """화면 replay.ts stateAt를 옮김: 마지막 시각의 손님 단계와 받은 손님 수."""
    customers, staff, done = {}, set(payload["initial_state"]["active_staff_keys"]), 0
    order = {
        "ARRIVED": "ORDER_QUEUE",
        "ORDER_STARTED": "ORDERING",
        "ORDER_COMPLETED": "WAITING_PREPARATION",
        "PREPARATION_STARTED": "PREPARING",
        "PREPARATION_COMPLETED": "WAITING_HANDOFF",
        "HANDOFF_STARTED": "WAITING_HANDOFF",
    }
    for e in sorted(
        payload["events"], key=lambda r: (r["at_seconds"], r["sequence_no"])
    ):
        if e["event_type"] == "STAFF_ON":
            staff.add(e["worker_key"])
        elif e["event_type"] == "STAFF_OFF":
            staff.discard(e["worker_key"])
        elif e["event_type"] == "HANDED_OVER":
            done += customers.get(e["customer_key"]) != "DONE"
            customers[e["customer_key"]] = "DONE"
        elif e["customer_key"]:
            customers[e["customer_key"]] = order[e["event_type"]]
    return customers, staff, done


def _traced(request, daily_orders=80):
    body = copy.deepcopy(request)
    body["scenario"]["daily_orders"] = daily_orders
    body["include_events"] = True
    staffing = parse(body)
    data = compare(
        {k: v for k, v in body.items() if k not in NOT_FOR_ENGINE},
        engine="reference",
        plan_rosters=staffing.rosters,
    )
    return data


def test_trace_payload_passes_spring_replay_checks():
    data = _traced(_request("simulation_request.json"))
    for plan in data["results"]:
        payload = build_payload(plan, data["repetitions"])
        spring_reads_trace(payload)
        assert payload["is_complete"] is True


def test_replay_ends_with_every_customer_handed_over():
    data = _traced(_request("simulation_request.json"))
    for plan in data["results"]:
        payload = build_payload(plan, data["repetitions"])
        customers, _, done = replay_end(payload)
        arrived = sum(e["event_type"] == "ARRIVED" for e in payload["events"])
        assert arrived > 0 and done == arrived and set(customers.values()) == {"DONE"}


def test_replay_staff_follow_the_received_plan():
    # 예시: CURRENT는 사장님 07시, 직원 10시 출근. ALT_C는 STAFF_2가 11:30~13:30.
    data = _traced(_request("simulation_request.json"))
    by_key = {p["choice_key"]: build_payload(p, 30) for p in data["results"]}
    assert by_key["CURRENT"]["initial_state"]["active_staff_keys"] == ["OWNER"]
    on = [
        (e["at_seconds"], e["worker_key"])
        for e in by_key["CURRENT"]["events"]
        if e["event_type"] == "STAFF_ON"
    ]
    assert (3 * 3600.0, "STAFF_1") in on
    alt_c = [
        (e["event_type"], e["at_seconds"], e["worker_key"])
        for e in by_key["ALT_C"]["events"]
        if e["event_type"] in ("STAFF_ON", "STAFF_OFF")
    ]
    assert ("STAFF_ON", 4.5 * 3600, "STAFF_2") in alt_c and (
        "STAFF_OFF",
        6.5 * 3600,
        "STAFF_2",
    ) in alt_c


def test_engine_detail_without_events_is_unchanged_for_spring():
    # 사건을 모아도 Spring에 가는 계약 응답에는 사건이 실리지 않는다(용량).
    request = _request("simulation_request.json")
    request["include_events"] = True
    data, _ = _run(request, daily_orders=80)
    assert all("first_run_events" not in row for row in data["results"])


def test_order_queue_wait_is_only_the_order_line():
    # 주문 줄 대기(도착 → 주문 시작)는 전체 대기(주문·제조·전달 줄 합)보다 작거나 같다.
    request = _request("simulation_request.json")
    staffing = parse(request)
    raw = compare(
        {k: v for k, v in request.items() if k not in NOT_FOR_ENGINE},
        engine="reference",
        plan_rosters=staffing.rosters,
    )
    data = build(raw, staffing)
    for plan, row in zip(raw["results"], data["results"]):
        order_line = row["metrics"]["order_queue_wait_mean_seconds"]
        assert order_line == pytest.approx(
            plan["stage_queue_wait_sec"]["order"]["mean"], abs=0.01
        )
        assert order_line <= plan["metrics"]["avg_queue_wait_sec"]["mean"] + 1e-6
