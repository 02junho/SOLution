"""compare 결과 → Spring 운영 계약(API 명세 v0.4) 응답.

Spring OperationResultContract.validateSimulation이 검사하는 칸을 채운다. 수치는 새로 계산하지 않고
compare가 30회 반복에서 구한 값(per_run, 쌍대 비교)을 이름과 모양만 바꿔 옮긴다.
엔진에만 있는 상세(시간대별 지표, 품질 판정, 구간별 인원)는 안별 행에 그대로 남겨 둔다.
Spring은 안별 행 전체를 detail.simulation_choices에 보존하므로 화면이 상세를 쓸 수 있다.
"""

from __future__ import annotations

import statistics

from .simulation_common import MIN_SLOT_ORDERS, target_text
from .staffing_input import EMPLOYEE_SCHEMA_VERSION, StaffingInput

REQUIRED_REPETITIONS = 30
STATISTICS_POLICY_VERSION = "operation.v1"
# 앞 4개는 비교(comparison.metric) 후보, 앞 5개는 추천 기준(basis_metric) 후보다(Spring METRICS 순서).
METRIC_SOURCES = {
    # 주문 줄 대기만. 엔진의 avg_queue_wait_sec은 주문·제조·전달 줄 대기를 모두 더한 값이라 쓰지 않는다.
    "order_queue_wait_mean_seconds": "order_queue_wait_sec",
    "post_order_wait_mean_seconds": "avg_post_order_receipt_sec",
    "total_time_mean_seconds": "avg_total_time_sec",
    "total_time_p90_seconds": "p90_total_time_sec",
    "post_order_wait_over_300_ratio": "post_order_receipt_over_300_sec_ratio",
    "completed_customer_count_mean": "completed_eventually",
}
OPEN_HOURS = 12  # 기본 07:00~19:00. 계산 결과의 영업시간(scenario.duration_min)을 쓴다.
COMPARISON_METRIC = "post_order_wait_mean_seconds"
BASIS_METRIC = "post_order_wait_over_300_ratio"
METRIC_DEFINITIONS = {
    "order_queue_wait_mean_seconds": {
        "label": "주문 줄 평균 대기",
        "unit": "seconds",
        "description": "도착부터 주문을 시작하기까지 기다린 시간의 하루 평균",
    },
    "post_order_wait_mean_seconds": {
        "label": "주문 후 수령까지 평균",
        "unit": "seconds",
        "description": "주문을 마친 뒤 음료를 받기까지 걸린 시간의 하루 평균",
    },
    "total_time_mean_seconds": {
        "label": "총 소요 평균",
        "unit": "seconds",
        "description": "도착부터 음료를 받기까지 걸린 시간의 하루 평균",
    },
    "total_time_p90_seconds": {
        "label": "총 소요 p90",
        "unit": "seconds",
        "description": "손님 90%가 이 시간 안에 음료를 받음",
    },
    "post_order_wait_over_300_ratio": {
        "label": "주문 후 300초 초과",
        "unit": "ratio",
        "description": "주문 후 수령까지 300초를 넘긴 손님 비율",
    },
    "completed_customer_count_mean": {
        "label": "평균 완료 고객",
        "unit": "customers",
        "description": "라스트 오더 전에 받은 주문 중 끝까지 만든 손님 수",
    },
    "throughput_per_hour_mean": {
        "label": "시간당 처리량",
        "unit": "customers_per_hour",
        "description": "마감까지 끝까지 만든 손님 수를 그날 영업시간으로 나눈 값",
    },
    "_aggregation": {
        "label": "집계 방식",
        "unit": None,
        "description": "30회 반복마다 하루 지표를 구하고, 화면 값은 30회의 평균. 비교는 같은 손님 흐름의 쌍대 차이와 95% 신뢰구간",
    },
}


class ContractError(ValueError):
    """Spring 계약에 맞는 결과를 만들 수 없을 때. router가 needs_input으로 돌려준다."""


def _run_metrics(run: dict, open_hours: float = OPEN_HOURS) -> dict:
    values = {name: run.get(source) for name, source in METRIC_SOURCES.items()}
    done = run.get("completed_by_close")
    values["throughput_per_hour_mean"] = (
        round(done / open_hours, 4) if done is not None else None
    )
    return values


def _mean_metrics(runs: list[dict]) -> dict:
    out = {}
    for name in list(METRIC_SOURCES) + ["throughput_per_hour_mean"]:
        xs = [r[name] for r in runs if r[name] is not None]
        out[name] = round(statistics.mean(xs), 4) if xs else None
    return out


def _comparison(plan: dict) -> dict | None:
    found = (plan.get("comparison_to_current") or {}).get("avg_post_order_receipt_sec")
    if found is None:
        return None
    if found["runs"] != REQUIRED_REPETITIONS or found["mean_diff"] is None:
        raise ContractError(
            "30회 모두에서 현재안과 비교할 손님이 있어야 비교 결과를 만들 수 있어요."
        )
    return {
        "metric": COMPARISON_METRIC,
        "label": "현재 대비 주문 후 수령 평균 차이",
        "delta_vs_current_seconds": found["mean_diff"],
        "ci95_lower_seconds": found["ci95_low"],
        "ci95_upper_seconds": found["ci95_high"],
        "paired_repetitions": found["runs"],
        "better_count": found["better_runs"],
        "verdict": found["verdict"],
    }


def _quality_rule(data: dict) -> str:
    """추천 기준 설명. 고정 문구가 아니라 이번 계산에 실제로 쓴 기준(quality_targets)을 보여 준다."""
    return (
        f"하루 전체와 손님 {MIN_SLOT_ORDERS}명 이상인 시간대마다 "
        f"{target_text(data['quality_targets'], data['repetitions'])}"
    )


def build(data: dict, staffing: StaffingInput) -> dict:
    """router가 붙이는 session_id·input_version_id·result_id·request_key·trace_refs는 그대로 둔다."""
    reps = data["repetitions"]
    if reps != REQUIRED_REPETITIONS:
        raise ContractError(
            f"운영 비교는 {REQUIRED_REPETITIONS}회 반복으로 계산해요. 반복 횟수를 {REQUIRED_REPETITIONS}으로 맞춰 주세요."
        )
    if data["scenario"].get("planned_orders_before_last_order_filter", 0) <= 0:
        raise ContractError(
            "하루 주문량이 0건이면 운영안을 비교할 수 없어요. 예상 주문량을 입력해 주세요."
        )
    by_key = {p["choice_key"]: p for p in data["results"]}
    open_hours = data["scenario"].get("duration_min", OPEN_HOURS * 60) / 60
    run_metrics = {
        key: [_run_metrics(run, open_hours) for run in plan["per_run"]]
        for key, plan in by_key.items()
    }
    for key, runs in run_metrics.items():
        if any(value is None for run in runs for value in run.values()):
            raise ContractError(
                "일부 반복에서 손님이 없어 지표를 만들 수 없어요. 예상 주문량을 늘려 주세요."
            )
    echo = {row["choice_key"]: row for row in staffing.echo}
    rows = []
    for key in ("CURRENT", "ALT_A", "ALT_C"):
        plan = by_key[key]
        row = {
            "choice_key": key,
            "metrics": _mean_metrics(run_metrics[key]),
            "comparison": None if key == "CURRENT" else _comparison(plan),
            # 엔진 상세: Spring이 detail.simulation_choices에 그대로 보존한다.
            "simulated_staffing": plan["staffing"],
            "quality_pass_rate": plan["quality_pass_rate"],
            "passes_quality_targets": plan["passes_quality_targets"],
            "by_slot": plan["by_slot"],
            "stage_queue_wait_sec": plan["stage_queue_wait_sec"],
            "main_queue_bottleneck_stage": plan["main_queue_bottleneck_stage"],
            "employee_utilization_during_day": plan["employee_utilization_during_day"],
            "p90_post_order_receipt_sec": plan["metrics"]["p90_post_order_receipt_sec"],
        }
        if staffing.mode == "employees":
            row["staffing"] = echo[key]["staffing"]
        rows.append(row)

    chosen = data["recommendation"]
    warnings = list(data["warnings"])
    recommendation = None
    if chosen.get("choice_key") is not None:
        recommendation = {
            "choice_key": chosen["choice_key"],
            "basis_metric": BASIS_METRIC,
            "reason": chosen["reason"],
            "outcome": chosen["outcome"],
            "runner_up_choice_key": chosen.get("runner_up_choice_key"),
            "quality_rule": _quality_rule(data),
        }
    else:
        warnings.append(
            {
                "warning_id": chosen["outcome"],
                "message": chosen["reason"],
                "requires_ack": False,
            }
        )

    replication_metrics = [
        {
            "replication_no": i + 1,
            "results": [
                {"choice_key": key, "metrics": run_metrics[key][i]}
                for key in ("CURRENT", "ALT_A", "ALT_C")
            ],
        }
        for i in range(reps)
    ]
    scenario = data["scenario"]
    out = {
        "model_version": data["model_version"],
        "engine": data["engine"],
        "complete": True,
        "requested_repetitions": reps,
        "completed_repetitions": reps,
        "random_seed": data["random_seed"],
        "statistics_policy_version": STATISTICS_POLICY_VERSION,
        "metric_definitions": METRIC_DEFINITIONS,
        "comparison_window": {
            "start_time": scenario.get("start", "07:00"),
            "end_time": scenario.get("end", "19:00"),
            "last_order_time": scenario.get("last_order_time"),
        },
        "recommendation": recommendation,
        "replication_metrics": replication_metrics,
        "scenario": scenario,
        "last_order": data["last_order"],
        "closing_policy": data["closing"],
        "quality_targets": data["quality_targets"],
        "estimated_menu_sales": data["estimated_menu_sales"],
        "warnings": warnings,
        "assumptions": [
            "모의 조건으로 계산한 결과이며 실제 매장 기록이 아닙니다.",
            "받은 근무표 그대로 손님 흐름을 30회 반복했고, 세 안은 같은 손님 흐름으로 비교했습니다.",
            "휴게는 시뮬레이션에 반영하지 않았습니다.",
            "라스트 오더 이후 손님은 받지 않고, 받은 주문은 끝까지 만들어 대기시간을 쟀습니다.",
        ],
        "method_disclaimer": data["method_disclaimer"],
        "model_assumptions": data["assumptions"],
    }
    if staffing.mode == "employees":
        out["staffing_schema_version"] = EMPLOYEE_SCHEMA_VERSION
        out["choices"] = rows
    else:
        out["results"] = rows
        out["staffing"] = staffing.echo
    return out
