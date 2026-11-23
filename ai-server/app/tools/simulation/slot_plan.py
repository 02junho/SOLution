"""시간대별 인원 추천과 시간대 조합 검증.

규칙(11.16 합의): 시간대를 시간 순으로 보며, 기준(반복 중 min_run_pass_rate 이상에서
주문 후 받기까지 P90 <= 기준)을 지키면서 추가 근무시간이 가장 적은 안을 고른다.
앞 시간대는 고정하고, 뒤 시간대는 잠시 그 후보를 그대로 쓴다. 한 시간대에서 넘어간 주문이
다음 시간대를 바꾸므로, 다 맞춘 하루를 한 번 더 돌려 확인한다.
"""

from __future__ import annotations

from .catalog import PLAN_IDS
from .day_window import day
from .simulation_common import MIN_SLOT_ORDERS, summarize
from .day_simulation import profile, roster, seconds

BASE_STAFF = 2
# 검증에 실패했을 때만 쓰는 보강 순서(같은 비용 먼저, 그다음 +1명).
UPGRADE = {"CURRENT": "ALT_A", "ALT_A": "ALT_C"}
MAX_REPAIRS = 4


def slot_hours(index: int) -> float:
    start, end = day().slots[index].split("-")
    return (seconds(end) - seconds(start)) / 3600


def extra_staff_hours(choice_key: str, index: int) -> float:
    return max(0, len(profile(choice_key)) - BASE_STAFF) * slot_hours(index)


def slot_roster(choice_keys: list[str]) -> list[dict]:
    slots = day().slots
    if len(choice_keys) != len(slots) or any(k not in PLAN_IDS for k in choice_keys):
        raise ValueError(
            f"slot choices need {len(slots)} values from {', '.join(PLAN_IDS)}"
        )
    return roster("four", list(choice_keys))


def slot_cohort_pass(record: dict, index: int, p90_limit: float) -> bool | None:
    """하루 판정(simulation_service._pass)과 같은 규칙: 그 시간대 손님 90% 이상이 p90_limit 안.
    그 시간대 주문이 MIN_SLOT_ORDERS건보다 적으면 None(판정 안 함).
    엔진은 받은 주문을 모두 끝내므로 cohort_completed_eventually == arrived_in_slot이다."""
    band = record["by_slot"][index]
    if band["cohort_completed_eventually"] < MIN_SLOT_ORDERS:
        return None
    served = band["served90_post_order_receipt_sec"]
    return served is not None and served <= p90_limit


def slot_pass_rate(records: list[dict], index: int, p90_limit: float) -> float | None:
    checked = [
        x
        for x in (slot_cohort_pass(r, index, p90_limit) for r in records)
        if x is not None
    ]
    return round(sum(checked) / len(checked), 4) if checked else None


def _candidate(key, index, records, quality):
    rate = slot_pass_rate(records, index, quality["max_p90_post_order_receipt_sec"])
    return {
        "choice_key": key,
        "staff_count": len(profile(key)),
        "extra_staff_hours": extra_staff_hours(key, index),
        "target_pass_rate": rate,
        "meets_target": rate is None or rate >= quality["min_run_pass_rate"],
        "p90_post_order_receipt_sec": summarize(
            [r["by_slot"][index]["p90_post_order_receipt_sec"] for r in records]
        )["mean"],
        "arrived_in_slot": summarize(
            [r["by_slot"][index]["arrived_in_slot"] for r in records]
        )["mean"],
    }


def _best(candidates):
    meeting = [c for c in candidates if c["meets_target"]]
    if meeting:
        # 싼 것부터. 비용이 같으면 더 안정적인 안, 그다음 더 빠른 안.
        return min(
            meeting,
            key=lambda c: (
                c["extra_staff_hours"],
                -(c["target_pass_rate"] or 0),
                c["p90_post_order_receipt_sec"]
                if c["p90_post_order_receipt_sec"] is not None
                else 1e9,
            ),
        )
    return min(
        candidates,
        key=lambda c: (
            -(c["target_pass_rate"] or 0),
            c["p90_post_order_receipt_sec"]
            if c["p90_post_order_receipt_sec"] is not None
            else 1e9,
        ),
    )


def slot_details(choice_keys, records, quality):
    return [
        {"slot": slot, **_candidate(key, i, records, quality)}
        for i, (slot, key) in enumerate(zip(day().slots, choice_keys))
    ]


def recommend_slots(run_roster, quality) -> dict:
    """run_roster(choice_keys) → 반복별 엔진 기록 목록(기억은 부르는 쪽이 한다)."""
    chosen: list[str] = []
    decisions = []
    slots = day().slots
    for index, slot in enumerate(slots):
        candidates = [
            _candidate(
                key, index, run_roster(chosen + [key] * (len(slots) - index)), quality
            )
            for key in PLAN_IDS
        ]
        pick = _best(candidates)
        chosen.append(pick["choice_key"])
        decisions.append(
            {
                "slot": slot,
                "choice_key": pick["choice_key"],
                "meets_target": pick["meets_target"],
                "candidates": candidates,
            }
        )
    repairs = []
    for _ in range(MAX_REPAIRS):
        details = slot_details(chosen, run_roster(chosen), quality)
        failing = next(
            (
                d
                for d in details
                if not d["meets_target"] and d["choice_key"] in UPGRADE
            ),
            None,
        )
        if failing is None:
            break
        index = slots.index(failing["slot"])
        upgraded = UPGRADE[chosen[index]]
        repairs.append(
            {
                "slot": failing["slot"],
                "from": chosen[index],
                "to": upgraded,
                "reason": "assembled_day_failed_slot_target",
            }
        )
        chosen[index] = upgraded
    return {
        "method": "sequential_cheapest_meeting_target",
        "choice_keys": chosen,
        "decisions": decisions,
        "repairs": repairs,
        "is_global_optimum": False,
    }
