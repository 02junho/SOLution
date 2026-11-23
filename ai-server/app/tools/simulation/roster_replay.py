"""저장한 추천 근무표의 하루를 한 번 다시 돌려 '줄 서는 모습' 재생 기록을 만든다(저장하지 않음).

- 손님은 근무표를 계산할 때와 같은 첫 번째 반복(같은 random_seed)이라, 결과 숫자를 낸 30번 중 첫 판을 그대로 보여 준다.
- 사람은 그 근무표의 근무조(휴게 포함)를 그대로 쓴다. 직원 이름은 없고 OWNER·STAFF_n 같은 근무조 이름만 쓴다.
- 기록 모양은 1번 재생과 같은 operation.trace.v2라 화면은 같은 계산(stateAt)으로 그린다.
"""

from __future__ import annotations

from .daily_roster import _shift_rows
from .day_simulation import DayCafe
from .day_window import from_scenario, using
from .simulation_common import _scenario, _validate, sample_menu_jobs
from .simulation_service import _presence
from .trace_log import build_payload

MAX_SHIFTS = 40


def _check_shifts(shifts) -> list[dict]:
    if not isinstance(shifts, list) or not shifts or len(shifts) > MAX_SHIFTS:
        raise ValueError(f"shifts는 1~{MAX_SHIFTS}개여야 해요.")
    out = []
    for s in shifts:
        if not isinstance(s, dict) or not isinstance(s.get("worker_key"), str):
            raise ValueError("근무조마다 worker_key가 필요해요.")
        for key in ("start_time", "end_time"):
            if not isinstance(s.get(key), str):
                raise ValueError(f"근무조에 {key}가 필요해요.")
        breaks = s.get("breaks") or []
        if not isinstance(breaks, list):
            raise ValueError("breaks는 목록이어야 해요.")
        out.append(
            {
                "worker_key": s["worker_key"],
                "is_owner": bool(s.get("is_owner")),
                "start_time": s["start_time"],
                "end_time": s["end_time"],
                "breaks": [{"start_time": b["start_time"], "end_time": b["end_time"]} for b in breaks],
            }
        )
    return out


def replay(body: dict, engine: str = "simpy") -> dict:
    """body = {"roster": 하루 근무표 요청(계산 때와 같은 조건), "shifts": 그 안의 근무조, "choice_key": 이름표}."""
    roster = body.get("roster")
    if not isinstance(roster, dict):
        raise ValueError("roster(하루 조건)가 필요해요.")
    shifts = _check_shifts(body.get("shifts"))
    spec = roster.get("scenario", {"daily_orders": 100})
    with using(from_scenario(spec)):
        _, seed, conf = _validate(roster)
        scn = _scenario(spec)
        orders, _ = sample_menu_jobs(scn, seed, conf)
        rows = _shift_rows(shifts)
        result = DayCafe(orders, rows, conf, "ROSTER_REPLAY", engine, include_events=True).simulate()
        plan = {
            "choice_key": str(body.get("choice_key") or "ROSTER"),
            "first_run_events": result["events"],
            "first_run_roster": _presence(rows),
        }
        payload = build_payload(plan, 1, scn)
    return {"model_version": "operation.roster_replay.v1", **payload}
