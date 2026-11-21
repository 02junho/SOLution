"""기준 결과(golden) 비교용 입력과 요약. 테스트와 기준 파일 다시 만들기가 같이 쓴다.

기준 파일을 다시 만들 때(결과가 바뀌는 게 맞을 때만, ai-server 폴더에서):
    python -m tests.operation_golden_cases
"""

from __future__ import annotations

import json
from pathlib import Path

from app.tools.simulation.simulation_service import compare
from app.tools.simulation.staffing_input import parse as parse_staffing

GOLDEN = Path(__file__).with_name("data") / "operation_golden.json"
DIGITS = 6


def _shift(worker, start, end, task):
    return {
        "worker_key": worker,
        "start_time": start,
        "end_time": end,
        "task_code": task,
    }


def spring_plans():
    """Spring OperationInputBuilder가 사장님 근무일 때 만드는 세 안(07~19시, 바쁜 시간 11~14시)."""
    lead, maker, extra = "OWNER", "STAFF_1", "STAFF_2"
    return [
        {
            "choice_key": "CURRENT",
            "shifts": [
                _shift(lead, "07:00", "19:00", "ORDER_HANDOFF"),
                _shift(maker, "07:00", "19:00", "PREPARATION"),
            ],
        },
        {
            "choice_key": "ALT_A",
            "shifts": [
                _shift(lead, "07:00", "11:00", "ORDER_HANDOFF"),
                _shift(lead, "11:00", "14:00", "ORDER_HANDOFF_HELP_PREPARATION"),
                _shift(lead, "14:00", "19:00", "ORDER_HANDOFF"),
                _shift(maker, "07:00", "11:00", "PREPARATION"),
                _shift(maker, "11:00", "14:00", "PREPARATION_HELP_ORDER_HANDOFF"),
                _shift(maker, "14:00", "19:00", "PREPARATION"),
            ],
        },
        {
            "choice_key": "ALT_C",
            "shifts": [
                _shift(lead, "07:00", "19:00", "ORDER_HANDOFF"),
                _shift(maker, "07:00", "19:00", "PREPARATION"),
                _shift(extra, "11:00", "14:00", "PREPARATION_HELP_ORDER_HANDOFF"),
            ],
        },
    ]


# 이름 → (엔진 입력, 근무표를 같이 보내는지)
CASES = {
    # 엔진이 정한 세 안 + 시간대별 추천(개발·직접 호출 경로)
    "engine_default_100": (
        {"scenario": {"daily_orders": 100}, "repetitions": 30},
        False,
    ),
    # Spring 경로: 근무표 세 안을 받아 계산. 라스트 오더·메뉴 비중·처리시간까지 바꾼 경우
    "spring_150_menu_weights": (
        {
            "scenario": {
                "daily_orders": 150,
                "last_order_time": "18:30",
                "share_method": "p50",
                "takeout_ratio": 0.4,
            },
            "repetitions": 10,
            "random_seed": 42,
            "execution_mode": "continuous_day",
            "selected_menu_ids": ["hot_americano", "iced_americano", "iced_cafe_latte"],
            "menu_weights": {
                "hot_americano": 0.2,
                "iced_americano": 0.5,
                "iced_cafe_latte": 0.3,
            },
            "order_time_sec": 50,
            "handoff_time_sec": 25,
        },
        True,
    ),
    "spring_default_60": (
        {"scenario": {"daily_orders": 60}, "repetitions": 10, "random_seed": 42},
        True,
    ),
}


def _round(value):
    if isinstance(value, float):
        return round(value, DIGITS)
    if isinstance(value, dict):
        return {k: _round(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_round(v) for v in value]
    return value


def summary(name):
    body, with_plans = CASES[name]
    rosters = None
    if with_plans:
        rosters = parse_staffing({"plans": spring_plans()}).rosters
    result = compare(dict(body), engine="simpy", plan_rosters=rosters)
    plans = {
        p["choice_key"]: {
            "per_run": p["per_run"],
            "by_slot_p90": [
                s["metrics"]["p90_post_order_receipt_sec"]["mean"] for s in p["by_slot"]
            ],
            "staff_hours": p["staffing"]["total_staff_hours"],
            "quality_pass_rate": p["quality_pass_rate"],
        }
        for p in result["results"]
    }
    slot = result.get("slot_recommendation")
    return _round(
        {
            "plans": plans,
            "recommendation": result["recommendation"]["choice_key"],
            "slot_choice_keys": slot["slot_choice_keys"] if slot else None,
        }
    )


def build():
    return {name: summary(name) for name in CASES}


if __name__ == "__main__":
    GOLDEN.parent.mkdir(exist_ok=True)
    GOLDEN.write_text(
        json.dumps(build(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8"
    )
    print(f"wrote {GOLDEN}")
