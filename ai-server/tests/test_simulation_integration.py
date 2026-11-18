"""4번 v1: paired simulation + contract regression.

Use internal reference scheduler so structural tests run without a DB. Team CI must also
run actual SimPy path with the pinned simpy==4.1.2 dependency installed.
"""

import math

from app.tools.simulation.catalog import options
from app.tools.simulation.simulation_service import compare


def test_three_choices_and_continuous_carryover():
    result = compare(
        {"scenario": {"daily_orders": 80}, "repetitions": 2}, engine="reference"
    )
    assert result["choice_keys"] == ["CURRENT", "ALT_A", "ALT_C"]
    assert result["carryover_between_slots"] is True
    for plan in result["results"]:
        assert len(plan["by_slot"]) == 4
        assert plan["choice_key"] in ("CURRENT", "ALT_A", "ALT_C")
        assert "plan_id" not in plan
        assert plan["repetitions"] == 2
        assert plan["staffing"]["total_staff_hours"] in (24, 27)
        assert "p90_post_order_receipt_sec" in plan["metrics"]
        assert "avg_queue_wait_sec" in plan["metrics"]
        assert "avg_total_time_sec" in plan["metrics"]
        assert "post_order_receipt_over_300_sec_ratio" in plan["metrics"]
        assert "rejected_demand" in plan["metrics"]
        # 19시 완료율 기준과 마감 후 인시는 결과에서 뺐다.
        assert "completion_ratio_by_close" not in plan["metrics"]
        assert "total_staff_hours_with_closeout" not in plan["metrics"]
        assert "unfinished_at_close" in plan["metrics"]


def test_staffing_is_calculation_roster_not_paid_hours():
    result = compare(
        {"scenario": {"daily_orders": 40}, "repetitions": 1}, engine="reference"
    )
    current, _, peak = result["results"]
    assert current["staffing"]["total_staff_hours"] == 24
    assert peak["staffing"]["total_staff_hours"] == 27
    assert peak["staffing"]["is_paid_work_hours"] is False
    slots = peak["staffing"]["time_slots"]
    assert [(s["start_time"], s["end_time"]) for s in slots] == [
        ("07:00", "11:00"),
        ("11:00", "14:00"),
        ("14:00", "17:00"),
        ("17:00", "19:00"),
    ]
    assert [s["staff_count"] for s in slots] == [2, 3, 2, 2]
    assert peak["staffing"]["peak_staff_count"] == 3
    extra = slots[1]["positions"][2]
    assert extra["primary_roles"] == ["preparation"] and extra["can_support"] == [
        "order",
        "handoff",
    ]


def test_last_order_keeps_unaccepted_demand_separate():
    body = {
        "scenario": {"daily_orders": 500, "last_order_time": "17:00"},
        "repetitions": 2,
    }
    result = compare(body, engine="reference")
    assert result["last_order"]["time"] == "17:00"
    assert result["last_order"]["rejected_demand"]["mean"] > 0
    assert result["last_order"]["rejected_demand_is_redistributed"] is False
    for plan in result["results"]:
        expected_accepted = 500 - result["last_order"]["rejected_demand"]["mean"]
        assert plan["metrics"]["arrived_orders"]["mean"] == expected_accepted


def test_estimated_sales_are_planned_not_actual_and_sums_match():
    result = compare(
        {
            "scenario": {"daily_orders": 201, "last_order_time": "19:00"},
            "repetitions": 2,
        },
        engine="reference",
    )
    expected = result["estimated_menu_sales"]
    assert expected["daily_total_cups"] == 201
    assert expected["is_actual_sales"] is False
    assert sum(m["cups"] for m in expected["menu_sales"]) == 201
    assert len(expected["menu_sales"]) == 5


def test_estimated_sales_count_only_accepted_orders():
    """라스트 오더 뒤 못 받은 손님은 2번에 넘길 예상 판매 잔수에서 뺀다."""
    result = compare(
        {
            "scenario": {"daily_orders": 500, "last_order_time": "17:00"},
            "repetitions": 2,
        },
        engine="reference",
    )
    expected = result["estimated_menu_sales"]
    assert expected["basis"] == "accepted_orders_mean"
    assert expected["daily_total_cups"] == round(
        500 - result["last_order"]["rejected_demand"]["mean"]
    )
    assert expected["planned_orders_before_last_order"] == 500


def test_default_quality_targets_and_removed_close_ratio_gate():
    import pytest

    result = compare(
        {"scenario": {"daily_orders": 70}, "repetitions": 1}, engine="reference"
    )
    assert result["quality_targets"]["max_p90_post_order_receipt_sec"] == 300
    assert result["quality_targets"]["min_run_pass_rate"] == 0.8
    assert "min_completion_ratio_by_close" not in result["quality_targets"]
    assert result["scenario"]["last_order_time"] == "18:45"
    assert result["closing"]["after_close_finish_is_quality_gate"] is False
    with pytest.raises(ValueError, match="no 19:00 completion-ratio gate"):
        compare(
            {
                "scenario": {"daily_orders": 70},
                "quality_targets": {"min_completion_ratio_by_close": 1.0},
                "repetitions": 1,
            },
            engine="reference",
        )


def test_repeat_uses_same_order_traces_for_each_plan():
    result = compare(
        {"scenario": {"daily_orders": 30}, "repetitions": 1, "include_events": True},
        engine="reference",
    )
    traces = [
        [
            (e["order_id"], e["time_sec"])
            for e in p["first_run_events"]
            if e["event_type"] == "arrival"
        ]
        for p in result["results"]
    ]
    assert traces[0] and traces[0] == traces[1] == traces[2]


def test_zero_orders_has_no_recommendation():
    result = compare(
        {"scenario": {"daily_orders": 0}, "repetitions": 1}, engine="reference"
    )
    assert result["recommendation"]["choice_key"] is None
    assert result["recommendation"]["outcome"] == "NO_ORDERS"


def test_source_catalog_preserves_five_menu_preset():
    selected = options()["selected_menus"]
    assert len(selected) == 5
    assert math.isclose(sum(x["sales_weight"] for x in selected), 1.0)


LEGACY_NAMES = (
    "plan_id",
    "plan_ids",
    "receipt_over_5min_ratio",
    "avg_receipt_time_sec",
    "rejected_by_last_order",
    "rejected_after_last_order",
    "over_five_minutes_ratio",
)


def _keys(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from _keys(child)
    elif isinstance(value, list):
        for child in value:
            yield from _keys(child)


def test_public_names_follow_team_convention():
    """팀 Code Convention: 안 키는 choice_key, 숫자 필드는 _sec/_min 단위 접미사, enum 값은 소문자."""
    result = compare(
        {
            "scenario": {"daily_orders": 60, "last_order_time": "18:45"},
            "repetitions": 2,
            "include_events": True,
        },
        engine="reference",
    )
    keys = set(_keys(result)) | set(_keys(options()))
    assert not keys & set(LEGACY_NAMES)
    assert not [k for k in keys if k.endswith("_seconds") or k.endswith("_minutes")]
    assert result["recommendation"]["choice_key"] in (None, "CURRENT", "ALT_A", "ALT_C")
    events = result["results"][0]["first_run_events"]
    assert events and all(e["event_type"] == e["event_type"].lower() for e in events)
    assert all("operating_mode" in row for row in result["results"][0]["roster"])


def test_demand_shares_file_matches_public_raw():
    """data/public 원본으로 다시 계산한 값이 엔진이 읽는 demand_shares.json과 같아야 한다."""
    from app.tools.simulation import preprocess

    if (
        not preprocess.RAW.exists()
    ):  # 원본이 없는 환경(예: Docker 이미지)에서는 비교할 수 없다
        return
    stored = preprocess.load()
    rebuilt = preprocess.build(write=False)
    assert stored["source_file"] == preprocess.RAW.name
    for band, share in rebuilt["normalized_shares"].items():
        assert math.isclose(
            stored["normalized_shares"][band], share, rel_tol=0, abs_tol=1e-12
        )
    assert [round(v * 100, 2) for v in stored["normalized_shares"].values()] == [
        32.82,
        49.68,
        14.81,
        2.68,
    ]


def test_engine_runs_without_public_raw(monkeypatch, tmp_path):
    """Docker 이미지에는 data/public이 없다. 엔진은 원본 없이 결과 파일만으로 돌아야 한다."""
    from app.tools.simulation import demand, preprocess

    monkeypatch.setattr(preprocess, "RAW", tmp_path / "missing.csv")
    demand.normalization.cache_clear()
    try:
        result = compare(
            {"scenario": {"daily_orders": 40}, "repetitions": 1}, engine="reference"
        )
        assert result["choice_keys"] == ["CURRENT", "ALT_A", "ALT_C"]
    finally:
        demand.normalization.cache_clear()


def test_compare_reports_complete_boolean_for_spring_contract():
    """API 명세 v0.4: Spring은 data.complete를 엄격한 boolean으로 확인한다."""
    data = compare(
        {"scenario": {"daily_orders": 60}, "repetitions": 2}, engine="reference"
    )
    assert data["complete"] is True


# ---------------------------------------------------------------- /compare 오류 처리 (Spring 연결)
def _client():
    import pytest

    pytest.importorskip("fastapi")
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    return TestClient(app)


def test_compare_explains_malformed_staffing_plan_instead_of_bare_422():
    # 근무표는 받지만(세 안 그대로 시뮬레이션) 모양이 틀리면 이유를 담은 400을 준다.
    body = {
        "scenario": {"daily_orders": 60},
        "plans": [{"choice_key": "CURRENT", "shifts": []}],
    }
    response = _client().post("/tools/simulation/compare", json=body)
    assert response.status_code == 400
    assert response.json()["status"] == "error"
    assert "세 안" in response.json()["message"]


def test_compare_limits_load_to_spring_wait_time():
    body = {"scenario": {"daily_orders": 301}, "repetitions": 30}
    data = _client().post("/tools/simulation/compare", json=body).json()
    assert data["status"] == "needs_input"
    assert data["data"]["detail_status"] == "LIMIT_EXCEEDED"
    assert "300건" in data["message"]


def test_compare_accepts_request_key_in_body_and_answers_with_header_key():
    body = {
        "scenario": {"daily_orders": 20},
        "repetitions": 1,
        "request_key": "body-key",
    }
    data = (
        _client()
        .post(
            "/tools/simulation/compare",
            json=body,
            headers={"X-Request-Key": "run:simulation"},
        )
        .json()
    )
    assert data["status"] == "ok"
    assert data["data"]["request_key"] == "run:simulation"
    assert data["data"]["complete"] is True
