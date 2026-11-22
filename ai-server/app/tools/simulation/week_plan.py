"""일주일 근무표 한 번에 만들기 (운영 2번 확장 E, 한 요청).

1. 요일마다 하루 근무표 조건(손님·사장님 근무)을 받아 시간대별 필요 인원을 한 번 찾는다.
2. 같은 필요 인원으로 근무조를 두 가지로 만든다.
   - 주휴 포함 안: 긴 조(최대 8시간)로 적은 인원
   - 주 15시간 미만 안: 3.5~7.5시간 조(weekly_roster.UNDER_15H_SHIFTS)로 나눠 한 사람이 주 여러 번 들어갈 수 있게
3. 안마다 요일별 직원 자리를 명단에 배정한다(weekly_roster, 정수 계획법).
요일 계산은 CPU 코어 수만큼 동시에 돌린다(결과는 순서대로 돌린 것과 같다). 저장하지 않는다.
"""

from __future__ import annotations

import multiprocessing
from concurrent.futures import ProcessPoolExecutor

from . import weekly_roster
from .daily_roster import plan_variants
from .parallel import worker_count

VARIANTS = {
    "WITH_HOLIDAY_PAY": {},
    "UNDER_15H": weekly_roster.UNDER_15H_SHIFTS,
}


def _day_job(args):
    day, roster_body, engine = args
    try:
        return day, plan_variants(roster_body, VARIANTS, engine=engine), None
    except ValueError as exc:
        return day, None, str(exc).removeprefix("NEEDS_INPUT:").strip()


def _run_days(jobs):
    count = worker_count(len(jobs))
    if count <= 1:
        return [_day_job(j) for j in jobs]
    try:
        with ProcessPoolExecutor(max_workers=count, mp_context=multiprocessing.get_context("spawn")) as pool:
            return list(pool.map(_day_job, jobs))
    except (OSError, RuntimeError):
        return [_day_job(j) for j in jobs]


def _day_view(roster):
    """화면에 필요한 만큼만(필요 인원·근무조·휴게·확인·인건비·빈 때)."""
    return {
        "scenario": roster["scenario"],
        "required_by_slot": roster["required_by_slot"],
        "shifts": roster["shifts"],
        "verification": roster["verification"],
        "cost": roster["cost"],
        "empty_periods": roster["empty_periods"],
        "rules": roster["rules"],
    }


def plan(body: dict, engine: str = "simpy") -> dict:
    days = body.get("days")
    if not isinstance(days, list) or not 1 <= len(days) <= 7:
        raise ValueError("요일별 조건(days)은 1~7개예요.")
    seen = set()
    jobs = []
    for d in days:
        day = d.get("day") if isinstance(d, dict) else None
        if day not in weekly_roster.DAYS or day in seen or not isinstance(d.get("roster"), dict):
            raise ValueError("요일은 MON~SUN을 한 번씩, 각 요일에 roster(하루 근무표 조건)를 보내 주세요.")
        seen.add(day)
        jobs.append((day, d["roster"], engine))
    mode = body.get("weekly_mode", "COMPARE")
    if mode not in weekly_roster.MODES:
        raise ValueError("weekly_mode는 UNDER_15H·WITH_HOLIDAY_PAY·COMPARE 중 하나예요.")
    modes = ("UNDER_15H", "WITH_HOLIDAY_PAY") if mode == "COMPARE" else (mode,)
    workers = weekly_roster._workers(body.get("workers"))

    finished = sorted(_run_days(jobs), key=lambda r: weekly_roster.DAYS.index(r[0]))
    skipped = [{"day": day, "reason": err} for day, _, err in finished if err]
    results = []
    for m in modes:
        day_shifts = [
            {
                "day": day,
                "shifts": [
                    {"start_time": s["start_time"], "end_time": s["end_time"], "breaks": s["breaks"]}
                    for s in rosters[m]["shifts"]
                    if not s["is_owner"]
                ],
            }
            for day, rosters, err in finished
            if not err
        ]
        assigned = weekly_roster.assign(weekly_roster._slots(day_shifts), workers, m) if day_shifts else None
        results.append(
            {
                "mode": m,
                "days": {day: _day_view(rosters[m]) for day, rosters, err in finished if not err},
                "weekly": assigned,
            }
        )
    return {
        "model_version": "operation.week_plan.v1",
        "weekly_mode": mode,
        "skipped_days": skipped,
        "results": results,
        "assumptions": [
            "요일마다 그 요일 평균 손님으로 시간대별 필요 인원을 한 번 찾고, 같은 필요 인원으로 근무조를 두 가지로 만들었어요.",
            f"주휴 포함 안은 긴 조(최대 8시간), 주 15시간 미만 안은 {weekly_roster.UNDER_15H_SHIFTS['short_shift_hours']:g}~{weekly_roster.UNDER_15H_SHIFTS['long_shift_hours']:g}시간 조로 나눴어요. 휴게는 근무 길이에 맞춰 넣고 다시 확인했어요.",
            *weekly_roster.plan({"days": [{"day": "MON", "shifts": []}], "workers": [{"worker_key": "x", "hourly_wage_krw": 1}]})[
                "assumptions"
            ][1:],
        ],
    }
