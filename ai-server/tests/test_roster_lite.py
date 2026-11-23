"""근무표 찾기용 가벼운 요약(DayCafe lite)이 전체 요약과 같은 값을 내는지."""
import json
from pathlib import Path

from app.tools.simulation.day_simulation import DayCafe
from app.tools.simulation.day_window import from_scenario, using
from app.tools.simulation.daily_roster import _count_rows, _shift_rows
from app.tools.simulation.simulation_common import _scenario, _validate, sample_menu_jobs

DATA = Path(__file__).parent / "data" / "busy_tue_roster.json"
KEYS = ("arrived_orders", "completed_eventually", "p90_post_order_receipt_sec", "served90_post_order_receipt_sec")
SLOT_KEYS = ("cohort_completed_eventually", "p90_post_order_receipt_sec", "served90_post_order_receipt_sec")


def test_가벼운_요약은_근무표가_읽는_값이_전체_요약과_같다():
    body = json.loads(DATA.read_text(encoding="utf-8"))
    with using(from_scenario(body["scenario"])):
        _, seed, conf = _validate(body)
        scn = _scenario(body["scenario"])
        slots = len(scn["slots"])
        tables = [
            _count_rows([1] * slots),
            _count_rows([1, 2, 3, 3, 2, 3, 3, 2, 2, 1, 1, 1, 1][:slots]),
            _shift_rows([
                {"worker_key": "OWNER", "is_owner": True, "start_time": scn["start"], "end_time": scn["end"], "breaks": []},
                {"worker_key": "STAFF_1", "is_owner": False, "start_time": "08:00", "end_time": "15:30",
                 "breaks": [{"start_time": "11:00", "end_time": "11:30"}]},
            ]),
        ]
        for k in range(3):
            orders, _ = sample_menu_jobs(scn, seed + k, conf)
            for part in (orders, [o for o in orders if 3600 <= o["arrival_sec"] < 4 * 3600]):
                for rows in tables:
                    full = DayCafe(part, rows, conf, "DAILY_ROSTER", "reference").simulate()
                    lite = DayCafe(part, rows, conf, "DAILY_ROSTER", "reference", lite=True).simulate()
                    assert {k2: lite[k2] for k2 in KEYS} == {k2: full[k2] for k2 in KEYS}
                    assert [{k2: b[k2] for k2 in SLOT_KEYS} for b in lite["by_slot"]] == [
                        {k2: b[k2] for k2 in SLOT_KEYS} for b in full["by_slot"]
                    ]
