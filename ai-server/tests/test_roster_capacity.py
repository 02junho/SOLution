"""사람을 더해도 대기가 안 주는 가게(머신 1대가 한계): 보강을 멈추고 그 시간대를 알려야 한다(개발기록 66번).

예전에는 seed에 따라 평일 근무조가 4개 → 10개로 늘었는데 바쁜 시간 대기는 149초 그대로였다.
"""

import json
from pathlib import Path

from app.tools.simulation import roster_options as ro

ROSTER = json.loads((Path(__file__).parent / "data" / "busy_tue_roster.json").read_text(encoding="utf-8"))


def staff(view):
    return [s for s in view["shifts"] if not s["is_owner"]]


def test_더해도_안_줄면_멈추고_시간대를_알린다():
    out = ro.day_options({**ROSTER, "random_seed": 2042, "repetitions": 20}, "reference", holiday=False)
    view = out["rosters"][str(out["picks"]["RECOMMENDED"])]
    assert len(staff(view)) <= 6  # 예전에는 10개
    limited = view["verification"]["capacity_limited"]
    assert limited and limited["slot"] == "08:00-09:00"
    assert view["verification"]["repairs"] == []  # 효과 없던 보강은 되돌렸다
