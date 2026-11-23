"""시간대 통계를 한 번에 모아 계산해도(속도 개선) 예전처럼 시간대마다 모든 작업을 훑은 값과 똑같아야 한다."""

import json
from pathlib import Path

from app.tools.simulation import daily_roster as dr
from app.tools.simulation.day_simulation import DayCafe, seconds
from app.tools.simulation.day_window import from_scenario, using
from app.tools.simulation.simulation_common import _scenario, _validate, sample_menu_jobs

ROSTER = json.loads((Path(__file__).parent / "data" / "busy_tue_roster.json").read_text(encoding="utf-8"))


def _naive_utilization(cafe, lo, hi):
    """예전 방식 그대로: 이 시간대에 모든 작업을 다시 훑어 겹친 시간을 더한다."""
    tasks = [t for j in cafe.jobs.values() for t in j["tasks"]]

    def overlap(t):
        if t["started_at"] is None:
            return 0.0
        end = t["ended_at"] if t["ended_at"] is not None else t["started_at"] + t["seconds"]
        return max(0.0, min(end, hi) - max(t["started_at"], lo))

    equipment = {n: round(sum(overlap(t) for t in tasks if t["equipment"] == n) / ((hi - lo) * c), 4)
                 for n, c in cafe.equipment_counts.items()}
    staff = {w["id"]: round(sum(overlap(t) for t in tasks if t.get("assigned_worker") == w["id"]) / (hi - lo), 4)
             for w in cafe.workers}
    return equipment, staff


def test_시간대_가동률은_예전_계산과_같다():
    with using(from_scenario(ROSTER["scenario"])):
        _, seed, conf = _validate(ROSTER)
        orders, _ = sample_menu_jobs(_scenario(ROSTER["scenario"]), seed, conf)
        for counts in ([1, 3, 3, 3, 3, 3, 3, 2, 2, 1, 1, 1, 1], [1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1]):
            cafe = DayCafe(orders, dr._count_rows(counts), conf, "T", "reference")
            result = cafe.simulate()
            assert result["by_slot"]
            for row in result["by_slot"]:
                lo, hi = map(seconds, row["slot"].split("-"))
                equipment, staff = _naive_utilization(cafe, lo, hi)
                assert row["equipment_utilization"] == equipment
                assert row["employee_utilization"] == staff
