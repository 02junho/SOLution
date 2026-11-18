"""구간별 추천, 회차별 지표(per_run), 짝지은 비교(CMP-002), 민감도 보고서."""

import pytest
from pydantic import ValidationError

from app.tools.simulation import slot_plan
from app.tools.simulation.catalog import SLOTS
import importlib.util
from pathlib import Path

# 개발용 보고서 스크립트(ai-server/scripts/simulation_report.py)는 패키지가 아니라 파일 경로로 불러온다.
_spec = importlib.util.spec_from_file_location(
    "simulation_report",
    Path(__file__).resolve().parents[1] / "scripts" / "simulation_report.py",
)
_report = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_report)
report_main, render = _report.main, _report.render
from app.schemas.simulation import CompareRequest
from app.tools.simulation.stats import paired_difference, t_critical_95
from app.tools.simulation.simulation_service import (
    USER_FACING,
    _ro,
    _slot_suggestion,
    compare,
    sensitivity,
)


# ---------------------------------------------------------------- 통계
def test_t_critical_matches_reference_values():
    assert t_critical_95(1) == 12.7062
    assert t_critical_95(29) == 2.0452
    assert abs(t_critical_95(60) - 2.0003) < 2e-4
    assert abs(t_critical_95(120) - 1.9799) < 2e-4
    with pytest.raises(ValueError):
        t_critical_95(0)


def test_paired_difference_verdicts():
    base = [100, 110, 120, 130, 140]
    faster = paired_difference(base, [b - 20 for b in base])
    assert (
        faster["verdict"] == "better"
        and faster["better_runs"] == 5
        and faster["mean_diff"] == -20
    )
    noisy = paired_difference(base, [b + d for b, d in zip(base, [-5, 4, -3, 5, -1])])
    assert (
        noisy["ci95_low"] <= 0 <= noisy["ci95_high"]
        and noisy["verdict"] == "no_difference"
    )
    slower = paired_difference(base, [b + 15 for b in base])
    assert slower["verdict"] == "worse" and slower["better_runs"] == 0
    assert paired_difference([None], [None])["verdict"] == "not_available"
    with pytest.raises(ValueError):
        paired_difference([1, 2], [1])


# ---------------------------------------------------------------- 회차별 지표
def test_per_run_and_comparison_to_current():
    result = compare(
        {"scenario": {"daily_orders": 150}, "repetitions": 6}, engine="reference"
    )
    for plan in result["results"]:
        assert len(plan["per_run"]) == 6
        assert [r["run_no"] for r in plan["per_run"]] == list(range(1, 7))
        assert {
            "avg_total_time_sec",
            "p90_post_order_receipt_sec",
            "passes_target",
        } <= set(plan["per_run"][0])
        passed = [r["passes_target"] for r in plan["per_run"]]
        assert plan["quality_pass_rate"] == round(sum(passed) / len(passed), 4)
    current = result["results"][0]
    assert current["comparison_to_current"] is None
    for plan in result["results"][1:]:
        cell = plan["comparison_to_current"]["avg_total_time_sec"]
        assert cell["runs"] == 6 and cell["verdict"] in (
            "better",
            "worse",
            "no_difference",
        )
        diffs = [
            p["avg_total_time_sec"] - c["avg_total_time_sec"]
            for c, p in zip(current["per_run"], plan["per_run"])
        ]
        assert cell["better_runs"] == sum(d < 0 for d in diffs)


def test_recommendation_ranks_by_scheduled_hours_and_names_runner_up():
    result = compare(
        {"scenario": {"daily_orders": 150}, "repetitions": 6}, engine="reference"
    )
    rec = result["recommendation"]
    assert rec["outcome"] == "RECOMMENDATION_AVAILABLE"
    assert rec["runner_up_choice_key"] in ("CURRENT", "ALT_A", "ALT_C")
    assert rec["runner_up_choice_key"] != rec["choice_key"]
    assert "staff_hours" in result["results"][0]["metrics"]


# ---------------------------------------------------------------- 구간별 추천
def _fake_records(p90_by_slot):
    by_slot = [
        {
            "arrived_in_slot": 20,
            "cohort_completed_eventually": 20,
            "p90_post_order_receipt_sec": v,
            "served90_post_order_receipt_sec": v,
        }
        for v in p90_by_slot
    ]
    return [{"by_slot": by_slot}] * 5


QUALITY = {"max_p90_post_order_receipt_sec": 300.0, "min_run_pass_rate": 0.8}


def test_sequential_rule_picks_cheapest_plan_meeting_target():
    """11~14시만 CURRENT·ALT_A가 목표를 못 지키는 가짜 결과 → 그 구간만 1명 추가."""

    def run(keys):
        return _fake_records(
            [
                350
                if (i == 1 and k != "ALT_C")
                else {"CURRENT": 250, "ALT_A": 200, "ALT_C": 150}[k]
                for i, k in enumerate(keys)
            ]
        )

    found = slot_plan.recommend_slots(run, QUALITY)
    assert found["choice_keys"] == ["ALT_A", "ALT_C", "ALT_A", "ALT_A"]
    assert found["repairs"] == []
    first = found["decisions"][0]["candidates"]
    assert [c["extra_staff_hours"] for c in first] == [0, 0, 4]


def test_no_plan_meets_target_keeps_the_most_reliable_one():
    found = slot_plan.recommend_slots(lambda keys: _fake_records([400] * 4), QUALITY)
    assert all(d["meets_target"] is False for d in found["decisions"])
    assert len(found["choice_keys"]) == 4


def test_assembled_day_is_repaired_when_carryover_breaks_a_slot():
    """07~11시는 뒤도 CURRENT일 때만 통과했는데, 14~17시가 ALT_A로 정해져 이어 붙인 하루에서 무너지는 경우."""
    table = {
        1: {"CURRENT": 250, "ALT_A": 260, "ALT_C": 150},
        2: {"CURRENT": 350, "ALT_A": 250, "ALT_C": 150},
        3: {"CURRENT": 200, "ALT_A": 210, "ALT_C": 150},
    }

    def run(keys):
        first = {
            "CURRENT": 350 if keys[2] == "ALT_A" else 200,
            "ALT_A": 280,
            "ALT_C": 150,
        }[keys[0]]
        return _fake_records(
            [first] + [table[i][k] for i, k in enumerate(keys) if i > 0]
        )

    found = slot_plan.recommend_slots(run, QUALITY)
    assert [d["choice_key"] for d in found["decisions"]] == [
        "CURRENT",
        "CURRENT",
        "ALT_A",
        "CURRENT",
    ]
    assert found["repairs"] == [
        {
            "slot": "07:00-11:00",
            "from": "CURRENT",
            "to": "ALT_A",
            "reason": "assembled_day_failed_slot_target",
        }
    ]
    assert found["choice_keys"] == ["ALT_A", "CURRENT", "ALT_A", "CURRENT"]


def test_slot_recommendation_on_real_engine():
    light = compare(
        {"scenario": {"daily_orders": 60}, "repetitions": 5}, engine="reference"
    )["slot_recommendation"]
    assert "ALT_C" not in light["slot_choice_keys"].values()
    assert light["staffing"]["total_staff_hours"] == 24
    heavy = compare(
        {"scenario": {"daily_orders": 300}, "repetitions": 5}, engine="reference"
    )["slot_recommendation"]
    assert list(heavy["slot_choice_keys"]) == list(SLOTS)
    assert heavy["slot_choice_keys"]["11:00-14:00"] == "ALT_C"
    assert heavy["staffing"]["time_slots"][1]["staff_count"] == 3
    assert heavy["is_global_optimum"] is False
    assert len(heavy["per_run"]) == 5 and len(heavy["decisions"]) == 4
    assert heavy["comparison_to_current"]["avg_total_time_sec"]["runs"] == 5
    assert (
        "choice_key" not in heavy
    )  # 팀 운영안 코드는 세 개뿐이라 조합안은 slot_choice_keys로만 표현한다


def test_zero_orders_skip_slot_recommendation():
    result = compare(
        {"scenario": {"daily_orders": 0}, "repetitions": 1}, engine="reference"
    )
    assert result["slot_recommendation"] is None


def test_owner_edited_slot_choices_are_verified():
    choices = {
        "07:00-11:00": "CURRENT",
        "11:00-14:00": "ALT_C",
        "14:00-17:00": "ALT_A",
        "17:00-19:00": "ALT_A",
    }
    result = compare(
        {"scenario": {"daily_orders": 150}, "repetitions": 4, "slot_choices": choices},
        engine="reference",
    )
    custom = result["custom_slot_plan"]
    assert custom["slot_choice_keys"] == choices
    assert [s["staff_count"] for s in custom["staffing"]["time_slots"]] == [2, 3, 2, 2]
    assert custom["staffing"]["total_staff_hours"] == 27
    assert [s["choice_key"] for s in custom["slots"]] == list(choices.values())
    assert custom["quality_pass_rate"] is not None
    with pytest.raises(ValueError, match="slot_choices needs every slot"):
        compare(
            {
                "scenario": {"daily_orders": 50},
                "repetitions": 1,
                "slot_choices": {"07:00-11:00": "ALT_A"},
            },
            engine="reference",
        )


def test_schema_defaults_and_slot_choices_validation():
    body = CompareRequest()
    assert body.scenario.last_order_time == "18:45"
    ok = CompareRequest(slot_choices={s: "ALT_A" for s in SLOTS})
    assert ok.slot_choices["11:00-14:00"] == "ALT_A"
    with pytest.raises(ValidationError):
        CompareRequest(slot_choices={s: "SOLO" for s in SLOTS})


# ---------------------------------------------------------------- 민감도
def test_korean_particle():
    assert (
        _ro("서로 돕기") == "로"
        and _ro("1명 추가") == "로"
        and _ro("현재 방식") == "으로"
    )


def test_sensitivity_is_judged_on_the_slot_recommendation():
    """사장님이 보는 추천(시간대별)이 기준. 주문량·제조시간 ±20%는 시간대별로 다시 계산한다."""
    data = sensitivity(
        {"scenario": {"daily_orders": 200}, "repetitions": 5}, engine="reference"
    )
    assert data["recommendation_basis"] == "slot_recommendation"
    base_keys = data["baseline_slot_plan"]["slot_choice_keys"]
    assert len(data["experiments"]) == 9
    for row in data["experiments"]:
        for plan in row["plans"].values():
            assert plan["change_vs_baseline"]["avg_post_order_receipt_sec"]["runs"] == 5
        if (row["dimension"], float(row["value"])) in USER_FACING:
            assert row["meaning_basis"] == "slot"
            assert row["base_slot_plan_under_variant"]["slot_choice_keys"] == base_keys
            expected = [
                s
                for s, k in row["slot_plan"]["slot_choice_keys"].items()
                if k != base_keys[s]
            ]
            assert [c["slot"] for c in row["slot_changes"]] == expected
            assert row["is_meaningful"] == (
                bool(row["slot_changes"]) or row["base_slot_plan_now_fails"]
            )
        else:
            assert row["meaning_basis"] == "day" and row["slot_plan"] is None
            assert row["is_meaningful"] == (
                row["recommendation_changed"] or row["recommended_plan_now_fails"]
            )
    meaningful = {
        (r["dimension"], float(r["value"]))
        for r in data["experiments"]
        if r["is_meaningful"]
    }
    for item in data["user_suggestions"]:
        key = (item["dimension"], float(item["value"]))
        assert key in USER_FACING and key in meaningful
    if data["user_suggestions"]:
        assert data["user_stable_message"] is None


def test_slot_suggestion_wording():
    base = {
        "07:00-11:00": "ALT_A",
        "11:00-14:00": "ALT_C",
        "14:00-17:00": "ALT_A",
        "17:00-19:00": "ALT_A",
    }
    ok = {"passes_quality_targets": True}
    removed = {
        "slot_changes": [{"slot": "11:00-14:00", "from": "ALT_C", "to": "ALT_A"}],
        "slot_plan": ok,
        "base_slot_plan_now_fails": False,
    }
    assert (
        _slot_suggestion("demand_scale", 0.8, removed, base)
        == "하루 손님이 20% 줄면 11~14시에 1명 더 쓰지 않아도 돼요."
    )
    added = {
        "slot_changes": [{"slot": "14:00-17:00", "from": "ALT_A", "to": "ALT_C"}],
        "slot_plan": ok,
        "base_slot_plan_now_fails": True,
    }
    assert (
        _slot_suggestion("demand_scale", 1.2, added, base)
        == "하루 손님이 20% 늘면 14~17시에도 1명 더 필요해요."
    )
    swap = {
        "slot_changes": [{"slot": "07:00-11:00", "from": "CURRENT", "to": "ALT_A"}],
        "slot_plan": {"passes_quality_targets": False},
        "base_slot_plan_now_fails": True,
    }
    text = _slot_suggestion(
        "manufacture_duration_scale", 1.2, swap, {**base, "07:00-11:00": "CURRENT"}
    )
    assert text.startswith(
        "직원 숙련도가 낮아 제조가 20% 느려지면 7~11시는 '서로 돕기'로 바꾸는 게 좋아요."
    )
    assert text.endswith("그래도 5분 목표를 다 지키기는 어려워요.")
    fails = {"slot_changes": [], "slot_plan": ok, "base_slot_plan_now_fails": True}
    assert "지금 추천한 시간대별 운영으로는" in _slot_suggestion(
        "demand_scale", 1.2, fails, base
    )
    assert (
        _slot_suggestion(
            "demand_scale", 1.2, {**fails, "base_slot_plan_now_fails": False}, base
        )
        is None
    )


def test_sensitivity_without_owner_dimensions_has_no_owner_message():
    data = sensitivity(
        {
            "scenario": {"daily_orders": 80},
            "repetitions": 3,
            "sensitivity_variations": [["order_time_sec", 45.0]],
        },
        engine="reference",
    )
    assert data["user_suggestions"] == [] and data["user_stable_message"] is None
    with pytest.raises(ValueError, match="Invalid sensitivity_variations"):
        sensitivity(
            {
                "scenario": {"daily_orders": 80},
                "sensitivity_variations": [["equipment", 2]],
            },
            engine="reference",
        )


def test_report_file(tmp_path):
    out = tmp_path / "report.md"
    raw = tmp_path / "report.json"
    report_main(
        [
            "--daily-orders",
            "120",
            "--repetitions",
            "3",
            "--engine",
            "reference",
            "--out",
            str(out),
            "--json",
            str(raw),
        ]
    )
    text = out.read_text(encoding="utf-8")
    for heading in (
        "## 기준 결과",
        "## 사장님께 보여 줄 제안",
        "## 유의미한 변화",
        "## 전체 결과",
        "## 판정 기준",
    ):
        assert heading in text
    assert "시간대별 추천(기준)" in text and "시간대별 추천 변화" in text
    assert raw.exists()


def test_report_lists_meaningful_rows_first():
    data = sensitivity(
        {"scenario": {"daily_orders": 200}, "repetitions": 3}, engine="reference"
    )
    text = render(data)
    meaningful_part = text.split("## 유의미한 변화")[1].split("## 전체 결과")[0]
    assert meaningful_part.count("- **") == sum(
        r["is_meaningful"] for r in data["experiments"]
    )


# ---------------------------------------------------------------- 통과 판정(손님 비율)
def test_served_by_counts_customers_not_interpolated_p90():
    from app.tools.simulation.day_simulation import percentile, served_by

    waits = [290, 301]
    assert percentile(waits) < 300  # 보간 P90은 300초 아래로 나오지만
    assert served_by(waits) > 300  # 5분 안에 받은 손님은 50%뿐이라 통과가 아니다
    assert served_by([100] * 9 + [400]) == 100  # 10명 중 9명(90%)이 100초 안
    assert served_by([100] * 8 + [400] * 2) == 400  # 80%면 통과 못 함


def test_slot_with_few_customers_is_not_judged():
    record = {
        "by_slot": [
            {
                "arrived_in_slot": 5,
                "cohort_completed_eventually": 5,
                "p90_post_order_receipt_sec": 900.0,
                "served90_post_order_receipt_sec": 900.0,
            }
        ]
    }
    assert slot_plan.slot_cohort_pass(record, 0, 300.0) is None


def test_request_key_allows_spring_stage_suffix():
    key = "k" * 100 + ":simulation"
    assert CompareRequest(request_key=key).request_key == key
    with pytest.raises(ValidationError):
        CompareRequest(request_key=key + "x")


def test_menu_step_without_equipment_runs():
    body = {
        "scenario": {"daily_orders": 30},
        "repetitions": 2,
        "selected_menus": [
            {
                "menu_id": "iced_americano",
                "sales_weight": 1.0,
                "manufacture_sec": 60,
                "steps": [{"name": "manual", "duration_sec": 60, "worker": True}],
            }
        ],
    }
    data = compare(body, engine="reference")
    assert data["results"]
