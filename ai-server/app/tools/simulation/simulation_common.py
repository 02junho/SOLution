"""Shared helpers for the day simulation: input checks, scenario, common random draws, aggregation.

The older whole-day engine, its compare/batch/sensitivity and the CLI runner were removed;
the public path is simulation_service (compare, sensitivity) on day_simulation.
"""

from __future__ import annotations
import copy
import random
import statistics
from .catalog import SLOTS, config_for
from .demand import DEMAND_PRESETS, scenario as base_scenario, draw_orders

DEMAND_LEVEL = DEMAND_PRESETS
# 시간대 판정은 그 시간대에 주문한 손님이 이 수 이상일 때만 한다(소표본 제외).
MIN_SLOT_ORDERS = 10


def _validate(body):
    if not isinstance(body, dict):
        raise ValueError("Request must be a JSON object")
    n = body.get("repetitions", 30)
    seed = body.get("random_seed", 42)
    if type(n) != int or not 1 <= n <= 100:
        raise ValueError("repetitions must be integer 1..100")
    if type(seed) != int or not 0 <= seed < 2**31 - 1000:
        raise ValueError("random_seed must be integer 0..2**31-1000")
    if body.get("execution_mode", "continuous_day") != "continuous_day":
        raise ValueError("execution_mode must be continuous_day")
    return n, seed, config_for(body)


def target_text(quality, repetitions):
    """추천 기준 문장. 실제 판정 기준(quality_targets)과 반복 수를 그대로 쓴다."""
    limit = quality["max_p90_post_order_receipt_sec"]
    limit_text = f"{limit / 60:g}분" if limit % 60 == 0 else f"{limit:g}초"
    rate = f"{quality['min_run_pass_rate'] * 100:g}%"
    return (
        f"주문 후 받기까지 손님 90%가 {limit_text} 이내, {repetitions}번 중 {rate} 이상"
    )


def _scenario(value):
    spec = copy.deepcopy(value)
    if not isinstance(spec, dict):
        raise ValueError("scenario must be an object")
    if "demand_level" in spec:
        level = spec.pop("demand_level")
        if (
            level not in DEMAND_LEVEL
            or "daily_orders" in spec
            or "orders_by_slot" in spec
        ):
            raise ValueError(
                "demand_level: low / medium / high only, no other demand field"
            )
        spec["daily_orders"] = DEMAND_LEVEL[level]
    result = base_scenario(spec)
    result["id"] = "CONTINUOUS_DAY"
    result["applied_assumptions"] = [
        "07:00-19:00 operates as one continuous queue with no resets at slot boundaries.",
        "Orders are one customer and one drink by model assumption; no sales forecast.",
        "Seoul payment-time distribution determines time shares only, not daily volume.",
        "Orders arriving after an optional early last_order_time are rejected and not rescheduled.",
    ]
    return result


def sample_menu_jobs(scn, rep_seed, conf):
    """Draw all randomness once; reuse these prepared jobs for every plan.

    Re-running with another time scale uses the same order arrivals, menu IDs,
    and Gaussian deviations. Automatic equipment time scales separately from
    employee duration; a Gaussian perturbation changes manual steps only.
    """
    orders, rejected = draw_orders(scn, rep_seed)
    rng = random.Random(rep_seed + 500_009)
    menus = conf["catalog"]["menus"]
    weights = [m["sales_weight"] for m in menus]
    ids = [m["menu_id"] for m in menus]
    lookup = {m["menu_id"]: m for m in menus}
    out = []
    for order in orders:
        mid = rng.choices(ids, weights=weights, k=1)[0]
        z = rng.gauss(0, 1)
        menu = lookup[mid]
        scale = conf["manufacture_duration_scale"]
        steps = copy.deepcopy(menu["steps"])
        for step in steps:
            step["seconds"] *= scale
        machine_total = sum(
            step["seconds"] for step in steps if step["equipment"] is not None
        )
        employee_steps = [step for step in steps if step["equipment"] is None]
        employee_total = sum(step["seconds"] for step in employee_steps)
        stddev = menu["manufacture_stddev_sec"] * conf["manufacture_variability_scale"]
        target = max(
            machine_total + len(employee_steps) * 1.0,
            menu["manufacture_sec"] * scale + stddev * z,
        )
        if employee_steps:
            factor = (target - machine_total) / employee_total
            for step in employee_steps:
                step["seconds"] *= factor
        out.append({**order, "menu_id": mid, "prepared_steps": steps})
    return out, rejected


def summarize(values):
    xs = [x for x in values if x is not None]
    if not xs:
        return {"mean": None, "stddev": None, "min": None, "max": None}
    return {
        "mean": round(statistics.mean(xs), 4),
        "stddev": round(statistics.stdev(xs), 4) if len(xs) > 1 else 0.0,
        "min": round(min(xs), 4),
        "max": round(max(xs), 4),
    }


API_METRIC_NAMES = {
    "completed_by_cutoff": "completed_by_close",
    "unfinished_at_cutoff": "unfinished_at_close",
    "completion_ratio_by_cutoff": "completion_ratio_by_close",
    "avg_queue_wait_sec": "avg_queue_wait_sec",
    "p90_queue_wait_sec": "p90_queue_wait_sec",
    "avg_elapsed_sec": "avg_total_time_sec",
    "plan_id": "choice_key",
    "overtime_to_drain_min": "after_close_drain_min",
}


def normalize_metrics(row):
    return {API_METRIC_NAMES.get(k, k): v for k, v in row.items() if k != "roster"}


def aggregate(records, plan, include_events):
    """Run-level records -> mean/stddev/min/max per metric. Quality is judged by the caller."""
    metrics = [
        "arrived_orders",
        "unfinished_at_cutoff",
        "completed_eventually",
        "avg_queue_wait_sec",
        "p90_queue_wait_sec",
        "avg_elapsed_sec",
        "post_order_receipt_over_300_sec_ratio",
        "overtime_to_drain_min",
    ]
    result = {
        "choice_key": plan,
        "repetitions": len(records),
        "metrics": {
            API_METRIC_NAMES.get(k, k): summarize([r[k] for r in records])
            for k in metrics
        },
        "stage_queue_wait_sec": {
            k: summarize([r["stage_queue_wait_sec"][k] for r in records])
            for k in ("order", "preparation", "handoff")
        },
        "equipment_utilization": {
            k: summarize([r["equipment_utilization"][k] for r in records])
            for k in records[0]["equipment_utilization"]
        },
        "employee_utilization_during_day": {
            k: summarize(
                [r["employee_utilization_during_day"].get(k, 0) for r in records]
            )
            for k in records[0]["employee_utilization_during_day"]
        },
        "max_equipment_concurrency": {
            k: max(r["max_equipment_concurrency"][k] for r in records)
            for k in records[0]["max_equipment_concurrency"]
        },
        "menu_order_counts": {
            k: summarize([r["menu_order_counts"].get(k, 0) for r in records])
            for k in sorted({k for r in records for k in r["menu_order_counts"]})
        },
        "by_slot": [],
        "first_run_metrics": normalize_metrics(
            {k: v for k, v in records[0].items() if k not in ("events", "by_slot")}
        ),
    }
    for index, slot in enumerate(SLOTS):
        keys = [
            "arrived_in_slot",
            "completed_in_slot",
            "backlog_at_start",
            "backlog_at_end",
            "carried_from_previous_slot",
            "carried_to_next_slot",
            "cohort_completed_by_slot_end",
            "cohort_completion_ratio_by_slot_end",
        ]
        result["by_slot"].append(
            {
                "slot": slot,
                "metrics": {
                    k: summarize([r["by_slot"][index][k] for r in records])
                    for k in keys
                },
            }
        )
    stages = result["stage_queue_wait_sec"]
    result["main_queue_bottleneck_stage"] = (
        max(stages, key=lambda k: stages[k]["mean"] or 0)
        if any(x["mean"] for x in stages.values())
        else None
    )
    if include_events:
        result["first_run_events"] = records[0]["events"]
    return result
