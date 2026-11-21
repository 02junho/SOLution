"""Per-slot staffing recommendation and verification of slot combinations.

Rule (agreed 11.16): for each slot in time order, keep the plan that meets the
target (post-order receipt P90 <= limit in >= min_run_pass_rate of runs) with
the fewest extra staff hours. Earlier slots stay fixed; later slots temporarily
use the candidate itself. The assembled day is then simulated again, because
orders carried over from one slot change the next one.
"""

from __future__ import annotations

from .catalog import PLAN_IDS
from .day_window import day
from .simulation_common import MIN_SLOT_ORDERS, summarize
from .day_simulation import profile, roster, seconds

BASE_STAFF = 2
# Capacity order used only to repair a failed verification (same cost first, then +1 person).
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
    """Same rule as the day check (simulation_service._pass): at least 90% of the slot's customers
    within p90_limit. None (not judged) when fewer than MIN_SLOT_ORDERS customers ordered in the slot.
    The engine completes every accepted order, so cohort_completed_eventually == arrived_in_slot."""
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
        # Cheapest first; on equal cost, the more reliable and then faster plan.
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
    """run_roster(choice_keys) -> list of per-run engine records (memoized by the caller)."""
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
