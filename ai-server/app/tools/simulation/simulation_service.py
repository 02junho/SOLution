"""늘 보여 주는 세 안, 시간대별 추천, 같은 손님으로 짝지은 반복 통계.

마감 규칙(11.16): 라스트 오더(기본 18:45) 뒤에는 새 주문을 받지 않고 19:00에 닫는다.
이미 받은 주문은 대기를 재려고 끝까지 만들지만, 마감 뒤 시간은 참고값일 뿐이다.
합격 기준이 아니고 직원 근무시간에도 넣지 않는다. 합격 = 주문 후 받기까지 P90이 기준 안,
하루 전체와 주문 10건 이상인 시간대마다, 반복 중 min_run_pass_rate 이상에서.
"""

from __future__ import annotations
import copy
import math
from .simulation_common import (
    _validate,
    _scenario,
    sample_menu_jobs,
    aggregate,
    summarize,
    target_text,
    MIN_SLOT_ORDERS,
)
from .day_simulation import DayCafe, roster_for_base, profile
from .demand import allocate
from .day_window import day, using, from_scenario
from .slot_plan import recommend_slots, slot_details, slot_roster
from .stats import paired_difference
from .staffing_input import simulated_staffing

BASE_PLANS = ("CURRENT", "ALT_A", "ALT_C")
QUALITY_KEYS = {"max_p90_post_order_receipt_sec", "min_run_pass_rate"}
SIMULATED_CONDITIONS_MESSAGE = (
    "모의 조건: 가정에 근거한 값이며 실제 매장과 다를 수 있어요."
)
# 반복마다 CURRENT와 견주는 지표(URQ-CMP-001). 모두 작을수록 좋다.
COMPARED_METRICS = (
    "avg_total_time_sec",
    "p90_total_time_sec",
    "avg_post_order_receipt_sec",
    "p90_post_order_receipt_sec",
    "post_order_receipt_over_300_sec_ratio",
    "avg_queue_wait_sec",
)
# 엔진 자체 보호 한도. Spring이 부르는 /compare는 응답 대기 120초에 맞춰 더 낮은 한도를 넘긴다(router).
MAX_ORDER_RUNS = 30000
PER_RUN_FIELDS = {
    "avg_total_time_sec": "avg_elapsed_sec",
    "p90_total_time_sec": "p90_elapsed_sec",
    "avg_post_order_receipt_sec": "avg_post_order_receipt_sec",
    "p90_post_order_receipt_sec": "p90_post_order_receipt_sec",
    "post_order_receipt_over_300_sec_ratio": "post_order_receipt_over_300_sec_ratio",
    "avg_queue_wait_sec": "avg_queue_wait_sec",
    "unfinished_at_close": "unfinished_at_cutoff",
    "arrived_orders": "arrived_orders",
    "completed_eventually": "completed_eventually",
    "completed_by_close": "completed_by_cutoff",
}


def _plans():
    """공개하는 세 안. 직접 고른 조합은 slot_choices(시간대별 안)로 받는다."""
    return {pid: roster_for_base(pid) for pid in BASE_PLANS}


def quality_from(body):
    supplied = body.get("quality_targets") or {}
    if not isinstance(supplied, dict) or set(supplied) - QUALITY_KEYS:
        raise ValueError(
            "quality_targets allows only max_p90_post_order_receipt_sec, min_run_pass_rate "
            "(no 19:00 completion-ratio gate)"
        )
    quality = {
        "max_p90_post_order_receipt_sec": float(
            supplied.get("max_p90_post_order_receipt_sec", 300.0)
        ),
        "min_run_pass_rate": float(supplied.get("min_run_pass_rate", 0.80)),
        "min_cohort_size_for_slot_p90": MIN_SLOT_ORDERS,
    }
    if (
        not 0 < quality["max_p90_post_order_receipt_sec"] <= 3600
        or not 0 <= quality["min_run_pass_rate"] <= 1
    ):
        raise ValueError("Invalid quality_targets")
    return quality


def _pass(record, p90_limit=300.0, min_slot_n=MIN_SLOT_ORDERS):
    """손님 90% 이상이 p90_limit 안에 받았는지(하루 전체와 손님이 min_slot_n 이상인 시간대마다).

    보간 P90이 아니라 실제 손님 비율로 판정한다(served90 <= limit 와 같음). 화면의 P90 숫자는 보간 값 그대로.
    """
    if record["arrived_orders"] == 0:
        return None
    if record["completed_eventually"] != record["arrived_orders"]:
        return False
    if (
        record["served90_post_order_receipt_sec"] is None
        or record["served90_post_order_receipt_sec"] > p90_limit
    ):
        return False
    for band in record["by_slot"]:
        if band["cohort_completed_eventually"] >= min_slot_n and (
            band["served90_post_order_receipt_sec"] is None
            or band["served90_post_order_receipt_sec"] > p90_limit
        ):
            return False
    return True


def _plus_stats(summary, records):
    summary["metrics"].update(
        {
            "staff_hours": summarize([r["staff_hours"] for r in records]),
            "staff_changes": summarize([r["staff_changes"] for r in records]),
            "avg_post_order_receipt_sec": summarize(
                [r["avg_post_order_receipt_sec"] for r in records]
            ),
            "p90_post_order_receipt_sec": summarize(
                [r["p90_post_order_receipt_sec"] for r in records]
            ),
            "p90_total_time_sec": summarize([r["p90_elapsed_sec"] for r in records]),
        }
    )
    for i, row in enumerate(summary["by_slot"]):
        row["metrics"].update(
            {
                "avg_queue_wait_sec": summarize(
                    [r["by_slot"][i]["avg_queue_wait_sec"] for r in records]
                ),
                "p90_queue_wait_sec": summarize(
                    [r["by_slot"][i]["p90_queue_wait_sec"] for r in records]
                ),
                "cohort_completed_by_close": summarize(
                    [r["by_slot"][i]["cohort_completed_by_close"] for r in records]
                ),
                "cohort_completed_eventually": summarize(
                    [r["by_slot"][i]["cohort_completed_eventually"] for r in records]
                ),
                "arrived_in_slot": summarize(
                    [r["by_slot"][i]["arrived_in_slot"] for r in records]
                ),
                "p90_post_order_receipt_sec": summarize(
                    [r["by_slot"][i]["p90_post_order_receipt_sec"] for r in records]
                ),
            }
        )
        row["equipment_utilization"] = {
            k: summarize([r["by_slot"][i]["equipment_utilization"][k] for r in records])
            for k in records[0]["by_slot"][i]["equipment_utilization"]
        }
        row["employee_utilization"] = {
            k: summarize([r["by_slot"][i]["employee_utilization"][k] for r in records])
            for k in records[0]["by_slot"][i]["employee_utilization"]
        }
    summary["roster"] = [
        {
            "start": r["start"],
            "end": r["end"],
            "operating_mode": r["plan_id"],
            "staff_count": r["staff_count"],
        }
        for r in records[0]["roster"]
    ]


def _per_run(records, p90_limit):
    # order_queue_wait_sec: 도착부터 주문 시작까지(주문 줄)만. avg_queue_wait_sec은 주문·제조·전달 줄 대기를 모두 더한 값이다.
    return [
        {
            "run_no": i + 1,
            **{api: r[key] for api, key in PER_RUN_FIELDS.items()},
            "order_queue_wait_sec": r["stage_queue_wait_sec"]["order"],
            "passes_target": _pass(r, p90_limit),
        }
        for i, r in enumerate(records)
    ]


def _summarize_plan(label, records, rejected_per_run, quality, include_events):
    agg = aggregate(records, label, include_events)
    _plus_stats(agg, records)
    agg["metrics"]["rejected_demand"] = summarize(rejected_per_run)
    agg["extra_employee_active"] = any(
        r["staff_count"] >= 3 for r in records[0]["roster"]
    )
    agg["staffing"] = _staffing(records[0]["roster"])
    agg["per_run"] = _per_run(records, quality["max_p90_post_order_receipt_sec"])
    checked = [
        x["passes_target"] for x in agg["per_run"] if x["passes_target"] is not None
    ]
    rate = sum(checked) / len(checked) if checked else None
    agg["quality_pass_rate"] = round(rate, 4) if rate is not None else None
    agg["passes_quality_targets"] = (
        bool(rate >= quality["min_run_pass_rate"]) if rate is not None else None
    )
    agg["quality_policy"] = (
        "Each run: at least 90% of customers receive their drink within max_p90_post_order_receipt_sec "
        "after ordering, for the full day and for every slot cohort with >= 10 orders; "
        "passes when >= min_run_pass_rate of runs pass."
    )
    return agg


def compare_to(current_per_run, per_run):
    return {
        metric: paired_difference(
            [r[metric] for r in current_per_run], [r[metric] for r in per_run]
        )
        for metric in COMPARED_METRICS
    }


def _rank(results):
    """추천 순서: 기준을 지키는 안을 근무시간 순으로, 나머지는 안정성 순으로."""

    def mean(p, key):
        value = p["metrics"][key]["mean"]
        return value if value is not None else 1e9

    feasible = sorted(
        (p for p in results if p["passes_quality_targets"] is True),
        key=lambda p: (
            mean(p, "staff_hours"),
            mean(p, "staff_changes"),
            mean(p, "avg_post_order_receipt_sec"),
        ),
    )
    others = sorted(
        (p for p in results if p["passes_quality_targets"] is not True),
        key=lambda p: (
            -(p["quality_pass_rate"] or 0),
            mean(p, "p90_post_order_receipt_sec"),
        ),
    )
    return feasible + others


def _choose(results, quality, repetitions):
    target = target_text(quality, repetitions)
    ranked = _rank(results)
    feasible = [p for p in ranked if p["passes_quality_targets"] is True]
    if not feasible:
        if all(p["passes_quality_targets"] is None for p in results):
            return {
                "outcome": "NO_ORDERS",
                "choice_key": None,
                "runner_up_choice_key": None,
                "reason": "주문량이 0건이어서 추천하지 않습니다.",
            }
        return {
            "outcome": "NO_FEASIBLE_PLAN",
            "choice_key": None,
            "runner_up_choice_key": None,
            "reason": f"세 운영안 모두 목표({target})에 못 미쳤어요.",
        }
    return {
        "outcome": "RECOMMENDATION_AVAILABLE",
        "choice_key": ranked[0]["choice_key"],
        "runner_up_choice_key": ranked[1]["choice_key"] if len(ranked) > 1 else None,
        "reason": f"목표({target})를 넘은 안 중 근무 시간이 가장 적은 안이에요.",
        "evaluated_candidates": len(results),
        "feasible_candidates": len(feasible),
        "is_global_optimum": False,
    }


def _staffing(rows):
    """시뮬레이션이 하루 네 시간대에 둔 자리. 유급시간·휴게·근무조가 아니다."""
    if any("assignments" in r for r in rows):
        return simulated_staffing(rows)  # 받은 근무표: 구간이 네 칸으로 고정되지 않는다
    slots = []
    for label in day().slots:
        start, end = label.split("-")
        row = next(r for r in rows if r["start"] <= start < r["end"])
        positions = []
        for i, groups in enumerate(profile(row["plan_id"])):
            positions.append(
                {
                    "position_id": f"EMP_{i + 1:02d}",
                    "primary_roles": list(groups[0]),
                    "can_support": list(
                        dict.fromkeys(task for group in groups[1:] for task in group)
                    ),
                }
            )
        slots.append(
            {
                "start_time": start,
                "end_time": end,
                "staff_count": row["staff_count"],
                "operating_mode": row["plan_id"],
                "positions": positions,
            }
        )
    total = round(
        sum((r["end_sec"] - r["start_sec"]) * r["staff_count"] / 3600 for r in rows), 4
    )
    return {
        "time_slots": slots,
        "peak_staff_count": max(s["staff_count"] for s in slots),
        "total_staff_hours": total,
        "unit": "person_hour",
        "is_paid_work_hours": False,
        "note": "시뮬레이션이 쓴 구간별 인원·역할. 실제 근무자 배정·휴게·인건비는 별도 계산.",
    }


def _presence(rows):
    """재생용: 구간마다 일하는 직원 이름(엔진 직원 id). 출근·퇴근 사건(STAFF_ON·OFF)을 만들 때 쓴다."""
    out = []
    for r in rows:
        if "assignments" in r:
            names = r["worker_keys"]
            present = [names[i] for i in sorted(r["assignments"])]
        else:
            present = [f"EMP_{i + 1:02d}" for i in range(len(profile(r["plan_id"])))]
        out.append(
            {"start_sec": r["start_sec"], "end_sec": r["end_sec"], "workers": present}
        )
    return out


def _slot_plan_result(choice_keys, records, rejected, quality, current, decisions=None):
    agg = _summarize_plan("SLOT_PLAN", records, rejected, quality, False)
    agg.pop("choice_key", None)
    agg["slot_choice_keys"] = dict(zip(day().slots, choice_keys))
    agg["slots"] = slot_details(choice_keys, records, quality)
    agg["comparison_to_current"] = compare_to(current["per_run"], agg["per_run"])
    if decisions is not None:
        agg.update(decisions)
    return agg


def compare(
    body,
    engine="simpy",
    include_slot_recommendation=True,
    max_order_runs=MAX_ORDER_RUNS,
    plan_rosters=None,
):
    """plan_rosters가 있으면(받은 근무표) 그 세 안으로 계산하고, 정해 둔 안 기준의 시간대별 추천은 만들지 않는다.

    영업시간은 scenario의 start_time·end_time(기본 07:00~19:00)이다. plan_rosters는 같은 영업시간으로
    만든 것이어야 한다(router가 같은 using() 안에서 만든다)."""
    spec = body.get("scenario") if isinstance(body, dict) else None
    with using(from_scenario(spec)):
        return _compare(
            body, engine, include_slot_recommendation, max_order_runs, plan_rosters
        )


def _compare(
    body,
    engine,
    include_slot_recommendation,
    max_order_runs,
    plan_rosters,
):
    quality = quality_from(body)
    repetitions, seed, conf = _validate(body)
    if engine not in ("reference", "simpy"):
        raise ValueError("engine must be reference or simpy")
    scn = _scenario(body.get("scenario", {"daily_orders": 100}))
    scn["id"] = "CONTINUOUS_DAY"
    if scn["planned_orders_before_last_order_filter"] * repetitions > max_order_runs:
        raise ValueError(
            f"NEEDS_INPUT: 계산 시간이 너무 길어져서, 주문 건수 × 반복 횟수를 {max_order_runs:,} 이하로 줄여 주세요 "
            f"(반복 30회면 하루 {max_order_runs // 30:,}건까지)."
        )
    custom = plan_rosters is not None
    selected = dict(plan_rosters) if custom else _plans()
    include_events = bool(body.get("include_events"))
    # 공통 난수: 한 번의 반복 안에서는 모든 근무표가 같은 손님을 받는다.
    draws = [sample_menu_jobs(scn, seed + run, conf) for run in range(repetitions)]
    rejected = [r for _, r in draws]
    cache = {}

    def run_roster(label, rows, events=False):
        key = (
            (label,)
            if "assignments" in rows[0]
            else tuple((r["start"], r["end"], r["plan_id"]) for r in rows),
            events,
        )
        if key not in cache:
            cache[key] = [
                DayCafe(
                    orders, rows, conf, label, engine, events and run == 0
                ).simulate()
                for run, (orders, _) in enumerate(draws)
            ]
        return cache[key]

    out = []
    for pid, rows in selected.items():
        agg = _summarize_plan(
            pid,
            run_roster(pid, rows, include_events),
            rejected,
            quality,
            include_events,
        )
        agg["choice_key"] = pid
        if include_events:
            agg["first_run_roster"] = _presence(rows)
        out.append(agg)
    current = next((p for p in out if p["choice_key"] == "CURRENT"), None)
    for p in out:
        p["comparison_to_current"] = (
            None
            if current is None or p is current
            else compare_to(current["per_run"], p["per_run"])
        )

    recommendation = _choose(out, quality, repetitions)
    winner = next(
        (p for p in out if p["choice_key"] == recommendation["choice_key"]), None
    )
    recommendation["staffing"] = winner["staffing"] if winner is not None else None

    slot_recommendation = None
    if (
        include_slot_recommendation
        and not custom
        and current is not None
        and scn["planned_orders_before_last_order_filter"] > 0
    ):
        found = recommend_slots(
            lambda keys: run_roster("SLOT_PLAN", slot_roster(keys)), quality
        )
        keys = found.pop("choice_keys")
        slot_recommendation = _slot_plan_result(
            keys,
            run_roster("SLOT_PLAN", slot_roster(keys)),
            rejected,
            quality,
            current,
            found,
        )
    custom_slot_plan = None
    if body.get("slot_choices") is not None and current is not None and not custom:
        choices = body["slot_choices"]
        slots = day().slots
        if not isinstance(choices, dict) or set(choices) != set(slots):
            raise ValueError(f"slot_choices needs every slot: {', '.join(slots)}")
        keys = [choices[s] for s in slots]
        custom_slot_plan = _slot_plan_result(
            keys, run_roster("SLOT_PLAN", slot_roster(keys)), rejected, quality, current
        )

    weighted = sum(
        m["sales_weight"] * m["manufacture_sec"] for m in conf["catalog"]["menus"]
    )
    menu_weights = [m["sales_weight"] for m in conf["catalog"]["menus"]]
    accepted_cups = (
        round(sum(len(orders) for orders, _ in draws) / len(draws)) if draws else 0
    )
    menu_counts = allocate(accepted_cups, menu_weights)
    estimated_menu_sales = {
        "data_type": "estimated_sales",
        "basis": "accepted_orders_mean",
        "source": "simulation_assumption",
        "is_actual_sales": False,
        "daily_total_cups": accepted_cups,
        "planned_orders_before_last_order": scn[
            "planned_orders_before_last_order_filter"
        ],
        "menu_sales": [
            {"menu_id": m["menu_id"], "cups": n}
            for m, n in zip(conf["catalog"]["menus"], menu_counts)
        ],
    }
    return {
        "model_version": "operation.v1",
        "engine": engine,
        "verified_with_actual_simpy": engine == "simpy",
        "execution_mode": "continuous_day",
        "carryover_between_slots": True,
        # 30회를 모두 마친 결과만 돌려준다(못 마치면 예외). Spring은 엄격한 boolean으로 확인한다(API 명세 v0.4).
        "complete": True,
        "repetitions": repetitions,
        "random_seed": seed,
        "scenario": scn,
        "choice_keys": list(selected),
        "results": out,
        "recommendation": recommendation,
        "slot_recommendation": slot_recommendation,
        "custom_slot_plan": custom_slot_plan,
        "estimated_menu_sales": estimated_menu_sales,
        "last_order": {
            "time": scn["last_order_time"],
            "rejected_demand": summarize(rejected),
            "rejected_demand_is_redistributed": False,
        },
        "closing": {
            "store_open_time": scn["start"],
            "store_close_time": scn["end"],
            "last_order_time": scn["last_order_time"],
            "accepted_orders_are_finished": True,
            "after_close_finish_is_quality_gate": False,
            "after_close_finish_counts_as_staff_hours": False,
        },
        "quality_targets": quality,
        "assumptions": {
            "order_time_sec": conf["order_time_sec"],
            "order_stddev_sec": conf["order_stddev_sec"],
            "handoff_time_sec": conf["handoff_time_sec"],
            "handoff_stddev_sec": conf["handoff_stddev_sec"],
            "manufacture_duration_scale": conf["manufacture_duration_scale"],
            "manufacture_variability_scale": conf["manufacture_variability_scale"],
            "equipment_counts": conf["equipment_counts"],
            "selected_menus": copy.deepcopy(conf["menus"]),
            "weighted_manufacture_sec": round(weighted, 3),
        },
        "warnings": [
            {
                "warning_id": "SIMULATED_CONDITIONS",
                "message": SIMULATED_CONDITIONS_MESSAGE,
                "requires_ack": True,
            }
        ],
        "method_disclaimer": (
            SIMULATED_CONDITIONS_MESSAGE
            + " 라스트 오더 이후 손님은 받지 않고 앞 시간대로 옮기지 않습니다. "
            "라스트 오더 전에 받은 주문은 끝까지 만들어 대기시간을 재지만, 19시를 넘긴 마무리는 참고 지표일 뿐 "
            "품질 기준이나 근무 인시에 넣지 않습니다. 휴게·급여·실제 근무표는 별도 계산이며 추천은 정해 둔 후보 안에서의 비교입니다."
        ),
    }


# ---------------------------------------------------------------- 민감도
DEFAULT_VARIATIONS = [
    ["demand_scale", 0.8],
    ["demand_scale", 1.2],
    ["manufacture_duration_scale", 0.8],
    ["manufacture_duration_scale", 1.2],
    ["manufacture_duration_scale", 1.4],
    ["manufacture_variability_scale", 0.0],
    ["manufacture_variability_scale", 1.5],
    ["order_time_sec", 45.0],
    ["handoff_time_sec", 20.0],
]
DIMENSIONS = (
    "demand_scale",
    "manufacture_duration_scale",
    "order_time_sec",
    "handoff_time_sec",
    "manufacture_variability_scale",
)
# 이 둘만 사장님께 보이는 제안이 된다(11.16 결정). 나머지는 개발자 보고서에만 둔다.
USER_FACING = {
    ("demand_scale", 0.8),
    ("demand_scale", 1.2),
    ("manufacture_duration_scale", 0.8),
    ("manufacture_duration_scale", 1.2),
}
PLAN_TITLES = {"CURRENT": "현재 방식", "ALT_A": "서로 돕기", "ALT_C": "1명 추가"}
STABLE_MESSAGE = (
    "하루 손님이나 직원 숙련도(제조시간)가 20% 달라져도 시간대별 추천은 그대로예요."
)


def _ro(word):
    """Korean particle 으로/로 for the quoted plan title."""
    last = word[-1]
    if not "가" <= last <= "힣":
        return "로"
    final = (ord(last) - 0xAC00) % 28
    return "로" if final in (0, 8) else "으로"


def _scaled_scenario(scenario, scale):
    spec = copy.deepcopy(scenario)
    if spec.get("orders_by_slot") is not None:
        spec["orders_by_slot"] = {
            k: int(round(v * scale)) for k, v in spec["orders_by_slot"].items()
        }
    elif spec.get("daily_orders") is not None:
        spec["daily_orders"] = int(round(spec["daily_orders"] * scale))
    else:
        raise ValueError(
            "demand_scale needs scenario.daily_orders or scenario.orders_by_slot"
        )
    return spec


def _variant_request(core, key, value):
    if key == "demand_scale":
        return {**core, "scenario": _scaled_scenario(core.get("scenario", {}), value)}
    return {**core, key: value}


def _plan_view(p):
    return {
        "avg_post_order_receipt_sec": p["metrics"]["avg_post_order_receipt_sec"][
            "mean"
        ],
        "p90_post_order_receipt_sec": p["metrics"]["p90_post_order_receipt_sec"][
            "mean"
        ],
        "quality_pass_rate": p["quality_pass_rate"],
        "passes_quality_targets": p["passes_quality_targets"],
    }


def _condition_text(key, value):
    pct = round(abs(value - 1) * 100)
    if key == "demand_scale":
        return f"하루 손님이 {pct}% {'늘면' if value > 1 else '줄면'}"
    if key == "manufacture_duration_scale":
        return (
            f"직원 숙련도가 낮아 제조가 {pct}% 느려지면"
            if value > 1
            else f"직원이 익숙해져 제조가 {pct}% 빨라지면"
        )
    return f"{key}={value}이면"


def _slot_label(slot):
    start, end = slot.split("-")
    if start.endswith(":00") and end.endswith(":00"):
        return f"{int(start[:2])}~{int(end[:2])}시"
    return f"{start}~{end}"  # 분이 있는 경계는 그대로(08:00~08:30)


def _join_slots(slots):
    return "·".join(_slot_label(x) for x in slots)


def _slot_suggestion(key, value, row, base_keys):
    """시간대별 안을 사장님 말로(사장님이 실제로 보는 추천)."""
    head = _condition_text(key, value)
    changes = row["slot_changes"]
    parts = []
    added = [c["slot"] for c in changes if c["to"] == "ALT_C" and c["from"] != "ALT_C"]
    removed = [
        c["slot"] for c in changes if c["from"] == "ALT_C" and c["to"] != "ALT_C"
    ]
    others = [c for c in changes if "ALT_C" not in (c["from"], c["to"])]
    if added:
        also = "에도" if "ALT_C" in base_keys.values() else "에"
        parts.append(f"{_join_slots(added)}{also} 1명 더 필요해요")
    if removed:
        parts.append(f"{_join_slots(removed)}에 1명 더 쓰지 않아도 돼요")
    for c in others:
        title = PLAN_TITLES[c["to"]]
        parts.append(
            f"{_slot_label(c['slot'])}는 '{title}'{_ro(title)} 바꾸는 게 좋아요"
        )
    if parts:
        text = f"{head} " + ", ".join(parts) + "."
        if row["slot_plan"]["passes_quality_targets"] is not True:
            text += " 그래도 5분 목표를 다 지키기는 어려워요."
        return text
    if row["base_slot_plan_now_fails"]:
        return f"{head} 지금 추천한 시간대별 운영으로는 5분 목표를 지키기 어려워요."
    return None


def _slot_view(plan):
    return {
        "slot_choice_keys": plan["slot_choice_keys"],
        "quality_pass_rate": plan["quality_pass_rate"],
        "passes_quality_targets": plan["passes_quality_targets"],
        "total_staff_hours": plan["staffing"]["total_staff_hours"],
    }


def sensitivity(body, engine="simpy"):
    spec = body.get("scenario") if isinstance(body, dict) else None
    with using(from_scenario(spec)):
        return _sensitivity(body, engine)


def _sensitivity(body, engine):
    """한 번에 조건 하나만 바꾸고, 모든 변형은 기준과 같은 seed를 쓴다.

    기준 = 시간대별 추천(사장님이 보는 것). 사장님께 보이는 네 조건(손님 ±20%, 제조 ±20%)은
    시간대별 안을 다시 계산하고, 기준 조합이 바뀐 조건에서도 맞는지 다시 확인한다.
    의미 있음 = 시간대 선택이 바뀌거나 기준 조합이 기준을 못 지킴. 다른 조건은 개발자용이라
    계산 시간을 줄이려고 하루 단위 세 안 추천으로만 본다.
    모든 안의 기준 대비 변화에는 짝지은 95% 구간(CMP-002)을 붙인다.
    """
    core = {
        k: v
        for k, v in body.items()
        if k not in ("include_events", "sensitivity_variations", "slot_choices")
    }
    core["include_events"] = False
    variants = body.get("sensitivity_variations") or DEFAULT_VARIATIONS
    if (
        not isinstance(variants, list)
        or len(variants) > 12
        or any(
            not isinstance(x, list)
            or len(x) != 2
            or x[0] not in DIMENSIONS
            or type(x[1]) not in (int, float)
            or not math.isfinite(x[1])
            or x[1] < 0
            for x in variants
        )
    ):
        raise ValueError("Invalid sensitivity_variations")
    scn = _scenario(core.get("scenario", {"daily_orders": 100}))
    load = sum(
        scn["planned_orders_before_last_order_filter"]
        * (value if key == "demand_scale" else 1)
        for key, value in variants
    )
    if (scn["planned_orders_before_last_order_filter"] + load) * core.get(
        "repetitions", 30
    ) > 120000:
        raise ValueError(
            "NEEDS_INPUT: 민감도 분석은 주문 건수 × 반복 횟수 × 실험 수를 120,000 이하로 줄여 주세요."
        )
    base = compare(core, engine, include_slot_recommendation=True)
    base_plans = {p["choice_key"]: p for p in base["results"]}
    base_rec = base["recommendation"]["choice_key"]
    runner_up = base["recommendation"].get("runner_up_choice_key")
    base_slot = base["slot_recommendation"]
    base_keys = base_slot["slot_choice_keys"] if base_slot else None
    experiments = []
    suggestions = []
    for key, value in variants:
        slot_basis = base_keys is not None and (key, float(value)) in USER_FACING
        request = _variant_request(core, key, value)
        if slot_basis:
            request = {**request, "slot_choices": base_keys}
        result = compare(request, engine, include_slot_recommendation=slot_basis)
        plans = {}
        for p in result["results"]:
            view = _plan_view(p)
            view["change_vs_baseline"] = {
                m: paired_difference(
                    [r[m] for r in base_plans[p["choice_key"]]["per_run"]],
                    [r[m] for r in p["per_run"]],
                )
                for m in ("avg_post_order_receipt_sec", "p90_post_order_receipt_sec")
            }
            plans[p["choice_key"]] = view
        rec = result["recommendation"]["choice_key"]
        top_two = None
        if base_rec and runner_up:
            by_key = {p["choice_key"]: p for p in result["results"]}
            top_two = paired_difference(
                [r["p90_post_order_receipt_sec"] for r in by_key[runner_up]["per_run"]],
                [r["p90_post_order_receipt_sec"] for r in by_key[base_rec]["per_run"]],
            )
        row = {
            "dimension": key,
            "value": value,
            "plans": plans,
            "recommendation": rec,
            "recommendation_changed": rec != base_rec,
            "recommended_plan_now_fails": bool(
                base_rec and plans[base_rec]["passes_quality_targets"] is not True
            ),
            # other − baseline = 추천안 − 2위안: "better"는 추천안이 더 빠르다는 뜻.
            "recommended_vs_runner_up_p90": top_two,
            "significant_changes": [
                pid
                for pid, v in plans.items()
                if v["change_vs_baseline"]["avg_post_order_receipt_sec"]["verdict"]
                in ("better", "worse")
            ],
            "meaning_basis": "slot" if slot_basis else "day",
            "slot_plan": None,
            "slot_changes": None,
            "base_slot_plan_under_variant": None,
            "base_slot_plan_now_fails": None,
        }
        if slot_basis:
            new = result["slot_recommendation"]
            kept = result["custom_slot_plan"]
            row["slot_plan"] = _slot_view(new)
            row["slot_changes"] = [
                {"slot": slot, "from": base_keys[slot], "to": choice}
                for slot, choice in new["slot_choice_keys"].items()
                if choice != base_keys[slot]
            ]
            row["base_slot_plan_under_variant"] = {
                **_slot_view(kept),
                "change_vs_baseline": {
                    m: paired_difference(
                        [r[m] for r in base_slot["per_run"]],
                        [r[m] for r in kept["per_run"]],
                    )
                    for m in (
                        "avg_post_order_receipt_sec",
                        "p90_post_order_receipt_sec",
                    )
                },
            }
            row["base_slot_plan_now_fails"] = kept["passes_quality_targets"] is not True
            row["is_meaningful"] = (
                bool(row["slot_changes"]) or row["base_slot_plan_now_fails"]
            )
        else:
            row["is_meaningful"] = (
                row["recommendation_changed"] or row["recommended_plan_now_fails"]
            )
        experiments.append(row)
        if slot_basis and row["is_meaningful"]:
            text = _slot_suggestion(key, value, row, base_keys)
            if text:
                suggestions.append({"dimension": key, "value": value, "message": text})
    ran_owner_checks = base_keys is not None and USER_FACING <= {
        (k, float(v)) for k, v in variants
    }
    return {
        "model_version": "operation.v1",
        "engine": engine,
        "method": "one_factor_at_a_time",
        "recommendation_basis": "slot_recommendation",
        "repetitions": base["repetitions"],
        "random_seed": base["random_seed"],
        "baseline": {pid: _plan_view(p) for pid, p in base_plans.items()},
        "baseline_recommendation": base_rec,
        "baseline_runner_up": runner_up,
        "baseline_slot_plan": _slot_view(base_slot) if base_slot else None,
        "experiments": experiments,
        "user_suggestions": suggestions,
        "user_stable_message": STABLE_MESSAGE
        if ran_owner_checks and not suggestions
        else None,
        "notice": "가정을 하나씩 바꿔 같은 손님 조건으로 다시 돌린 결과입니다. 실제 제조시간이나 수요를 검증한 것은 아닙니다.",
    }
