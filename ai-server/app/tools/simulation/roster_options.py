"""추천 근무표 3안 (운영 2번 가게 데이터 확장, 한 요청).

사장님이 묻는 것: "사람을 더 쓰면 대기가 얼마나 줄고, 몇 명을 어떻게 써야 하나(주 15시간 미만으로)".

요일마다
1. 시간대별 꼭 필요한 인원(기준을 지키는 가장 적은 인원)을 한 번 찾는다(daily_roster._prepare).
2. 바쁜 시간을 최대 2구간 잡는다. 첫 구간은 시나리오의 바쁜 시간(가게 데이터면 주문이 가장 몰린 때),
   둘째 구간은 시간대별 주문이 있을 때만, 첫 구간과 겹치지 않고 시간당 주문이 하루 평균의 PEAK2_MIN_RATIO배 이상인 곳
   (첫 구간에 바로 붙어도 된다: 아침부터 점심까지 길게 바쁜 가게).
3. 한가한 시간은 꼭 필요한 인원 그대로 두고, 바쁜 시간에만 0~MAX_EXTRA명을 더해 돌려 본다(휴게 없이 어림).
4. 세 안을 고른다.
   - 아끼는 안: 더하지 않음
   - 추천안: 한 명 더할 때마다 바쁜 시간 대기가 MIN_GAIN_SEC 넘게 줄어드는 데까지
   - 여유 안: 추천안 + 1명
5. 세 안을 짧은 근무조(주 15시간 미만으로 나누기 좋은 3.5~5시간)로 덮고 휴게를 넣어 다시 확인한다.
   추천안은 긴 근무조(주휴 포함)로도 만들어 비교한다.
주 단위로는 안마다 요일별 직원 자리를 명단에 배정한다(weekly_roster). 저장하지 않는다.
"""

from __future__ import annotations

import math
import multiprocessing
from concurrent.futures import ProcessPoolExecutor

from . import weekly_roster
from .daily_roster import _build, _count_rows, _prepare, _rules
from .parallel import worker_count
from .day_window import day, from_scenario, using
from .simulation_common import summarize

MAX_EXTRA = 3
MIN_GAIN_SEC = 30
PEAK2_MIN_RATIO = 1.3
# 주 15시간 미만으로 나눌 때 한 사람이 일할 수 있는 최대(30분 단위).
UNDER_15H_MAX_HOURS = 14.5
SHORT_RULES = {"long_shift_hours": 5, "short_shift_hours": 3.5}
LONG_RULES: dict = {}
OPTIONS = (
    ("SAVE", "아끼는 안"),
    ("RECOMMENDED", "추천안"),
    ("ROOMY", "여유 안"),
)


def busy_windows(scn) -> list[dict]:
    """바쁜 시간 최대 2구간. [{start_time, end_time, slots: [시간대 번호]}]."""
    d = day()
    slots = list(d.slots)
    starts = [s.split("-")[0] for s in slots]
    ends = [s.split("-")[1] for s in slots]
    first = [i for i in range(len(slots)) if starts[i] >= d.peak[0] and ends[i] <= d.peak[1]]
    if not first:
        return []
    out = [{"start_time": d.peak[0], "end_time": d.peak[1], "slots": first}]
    if not d.is_store:
        return out  # 상권 비중(4구간)일 때는 둘째 구간을 찾지 않는다.
    orders = [scn["orders_by_slot"][s] for s in slots]
    hours = [(d.rel(ends[i]) - d.rel(starts[i])) / 3600 for i in range(len(slots))]
    day_rate = sum(orders) / sum(hours)
    size = min(3, max(2, len(first)))
    blocked = set(first)
    best = None
    for a in range(len(slots) - size + 1):
        window = list(range(a, a + size))
        if blocked & set(window):
            continue
        rate = sum(orders[i] for i in window) / sum(hours[i] for i in window)
        if rate >= PEAK2_MIN_RATIO * day_rate and (best is None or rate > best[0]):
            best = (rate, window)
    if best:
        w = best[1]
        out.append({"start_time": starts[w[0]], "end_time": ends[w[-1]], "slots": w})
    return sorted(out, key=lambda x: x["start_time"])


def _window_waits(slot_p90, windows):
    """구간마다 가장 긴 시간대 대기(초). 주문이 적어 대기를 못 잰 시간대는 뺀다."""
    out = []
    for w in windows:
        vals = [slot_p90[i] for i in w["slots"] if slot_p90[i] is not None]
        out.append(max(vals) if vals else None)
    return out


def _worst(values):
    vals = [v for v in values if v is not None]
    return max(vals) if vals else None


def _ladder(ctx, windows, min_gain=MIN_GAIN_SEC):
    """바쁜 시간에만 0~MAX_EXTRA명을 더했을 때(휴게 없이) 대기. 꼭 필요한 인원은 그대로.
    한 명 더해도 min_gain초 넘게 안 줄면 거기서 멈춘다(그 단계가 여유 안이라 더 돌려도 고르는 안이 같다)."""
    counts, run, max_staff = ctx["counts"], ctx["run"], ctx["rules"]["max_staff"]
    busy = {i for w in windows for i in w["slots"]}
    out = []
    for k in range(MAX_EXTRA + 1):
        extra = [min(max_staff, c + k) if i in busy else c for i, c in enumerate(counts)]
        if k and extra == out[-1]["counts"]:
            break  # 최대 인원에 닿았다
        records = run(_count_rows(extra))
        slot_p90 = [
            summarize([r["by_slot"][i]["p90_post_order_receipt_sec"] for r in records])["mean"]
            for i in range(len(counts))
        ]
        waits = _window_waits(slot_p90, windows)
        out.append(
            {
                "extra": k,
                "counts": extra,
                "peak_wait_sec": _worst(waits),
                "by_window_sec": waits,
                "day_p90_sec": summarize([r["p90_post_order_receipt_sec"] for r in records])["mean"],
            }
        )
        if k and (
            out[-2]["peak_wait_sec"] is None
            or out[-1]["peak_wait_sec"] is None
            or out[-2]["peak_wait_sec"] - out[-1]["peak_wait_sec"] < min_gain
        ):
            break
    return out


def _pick(ladder, min_gain):
    """추천: 한 명 더할 때마다 바쁜 시간 대기가 min_gain초 넘게 줄어드는 데까지."""
    k = 0
    for prev, cur in zip(ladder, ladder[1:]):
        if prev["peak_wait_sec"] is None or cur["peak_wait_sec"] is None:
            break
        if prev["peak_wait_sec"] - cur["peak_wait_sec"] < min_gain:
            break
        k = cur["extra"]
    roomy = min(k + 1, ladder[-1]["extra"])
    return {"SAVE": 0, "RECOMMENDED": k, "ROOMY": roomy}


def _view(roster, windows):
    waits = _window_waits(roster["slot_p90_sec"], windows)
    return {
        "scenario": roster["scenario"],
        "required_by_slot": roster["required_by_slot"],
        "shifts": roster["shifts"],
        "verification": roster["verification"],
        "cost": roster["cost"],
        "empty_periods": roster["empty_periods"],
        "rules": roster["rules"],
        "peak_wait_sec": _worst(waits),
        "by_window_sec": waits,
    }


def day_options(body: dict, engine: str = "simpy", min_gain: float = MIN_GAIN_SEC) -> dict:
    """한 요일: 바쁜 시간, 더하기 비교, 세 안 근무표(짧은 조) + 추천안 긴 조."""
    spec = body.get("scenario") if isinstance(body, dict) else None
    with using(from_scenario(spec)):
        ctx = _prepare(body, engine)
        windows = busy_windows(ctx["scn"])
        ladder = _ladder(ctx, windows, min_gain)
        picks = _pick(ladder, min_gain)
        short = _rules({**body, "roster_rules": {**(body.get("roster_rules") or {}), **SHORT_RULES}}, ctx["minor"])
        long_ = _rules({**body, "roster_rules": {**(body.get("roster_rules") or {}), **LONG_RULES}}, ctx["minor"])
        built = {}
        for k in sorted(set(picks.values())):
            built[k] = _view(_build({**ctx, "counts": ladder[k]["counts"]}, short), windows)
        holiday = _view(_build({**ctx, "counts": ladder[picks["RECOMMENDED"]]["counts"]}, long_), windows)
        return {
            "windows": [{"start_time": w["start_time"], "end_time": w["end_time"]} for w in windows],
            "required_staff": ctx["counts"],
            "slots": list(day().slots),
            "ladder": [{k: v for k, v in step.items() if k != "counts"} for step in ladder],
            "picks": picks,
            "rosters": {str(k): v for k, v in built.items()},
            "holiday_roster": holiday,
        }


def _day_job(args):
    day_name, roster_body, engine, min_gain = args
    try:
        return day_name, day_options(roster_body, engine, min_gain), None
    except ValueError as exc:
        return day_name, None, str(exc).removeprefix("NEEDS_INPUT:").strip()


def _run_days(jobs):
    count = worker_count(len(jobs))
    if count <= 1:
        return [_day_job(j) for j in jobs]
    try:
        with ProcessPoolExecutor(max_workers=count, mp_context=multiprocessing.get_context("spawn")) as pool:
            return list(pool.map(_day_job, jobs))
    except (OSError, RuntimeError):
        return [_day_job(j) for j in jobs]


def _staff_shifts(view):
    return [
        {"start_time": s["start_time"], "end_time": s["end_time"], "breaks": s["breaks"]}
        for s in view["shifts"]
        if not s["is_owner"]
    ]


def _assign(day_views, workers, mode):
    days = [{"day": d, "shifts": _staff_shifts(v)} for d, v in day_views.items()]
    if not any(d["shifts"] for d in days):
        return {"optimal": True, "assignments": [], "unfilled": [], "workers": [], "people_used": 0,
                "weekly_cost_krw": 0, "holiday_pay_krw": 0}
    return weekly_roster.assign(weekly_roster._slots(days), workers, mode)


def _shortfall(weekly):
    """못 채운 자리를 주 15시간 미만 알바로 채우려면 몇 명이 더 필요한지(어림)."""
    hours = sum(u["work_hours"] for u in weekly["unfilled"])
    return {"unfilled_hours": hours, "more_people_under_15h": math.ceil(hours / UNDER_15H_MAX_HOURS) if hours else 0}


def plan(body: dict, engine: str = "simpy") -> dict:
    days = body.get("days")
    if not isinstance(days, list) or not 1 <= len(days) <= 7:
        raise ValueError("요일별 조건(days)은 1~7개예요.")
    min_gain = body.get("min_gain_sec", MIN_GAIN_SEC)
    if type(min_gain) not in (int, float) or not 10 <= min_gain <= 300:
        raise ValueError("min_gain_sec는 10~300초예요.")
    seen, jobs = set(), []
    for d in days:
        name = d.get("day") if isinstance(d, dict) else None
        if name not in weekly_roster.DAYS or name in seen or not isinstance(d.get("roster"), dict):
            raise ValueError("요일은 MON~SUN을 한 번씩, 각 요일에 roster(하루 근무표 조건)를 보내 주세요.")
        seen.add(name)
        jobs.append((name, d["roster"], engine, min_gain))
    workers = weekly_roster._workers(body.get("workers"))

    finished = sorted(_run_days(jobs), key=lambda r: weekly_roster.DAYS.index(r[0]))
    skipped = [{"day": n, "reason": err} for n, _, err in finished if err]
    done = {n: r for n, r, err in finished if not err}

    options = []
    for key, title in OPTIONS:
        views = {n: r["rosters"][str(r["picks"][key])] for n, r in done.items()}
        weekly = _assign(views, workers, "UNDER_15H")
        options.append(
            {
                "key": key,
                "title": title,
                "extra_by_day": {n: r["picks"][key] for n, r in done.items()},
                "days": views,
                "weekly": weekly,
                "shortfall": _shortfall(weekly),
                "daily_cost_krw": {n: v["cost"]["cash_cost_krw"] for n, v in views.items()},
                # 근무표 전체 인건비(못 채운 자리도 누군가 일한다고 보고). 15시간 미만이라 주휴는 없다.
                "plan_cost_krw": sum(v["cost"]["cash_cost_krw"] for v in views.values()),
                "peak_wait_sec": {n: v["peak_wait_sec"] for n, v in views.items()},
            }
        )
    holiday_views = {n: r["holiday_roster"] for n, r in done.items()}
    holiday = _assign(holiday_views, workers, "WITH_HOLIDAY_PAY")
    holiday_cost = sum(v["cost"]["cash_cost_krw"] for v in holiday_views.values()) + holiday["holiday_pay_krw"]
    return {
        "model_version": "operation.roster_options.v1",
        "min_gain_sec": min_gain,
        "skipped_days": skipped,
        "days": {
            n: {"windows": r["windows"], "ladder": r["ladder"], "picks": r["picks"], "slots": r["slots"],
                "required_staff": r["required_staff"]}
            for n, r in done.items()
        },
        "options": options,
        "holiday_compare": {"key": "RECOMMENDED", "days": holiday_views, "weekly": holiday, "plan_cost_krw": holiday_cost},
        "assumptions": [
            "요일마다 그 요일 평균 손님으로 시간대별 꼭 필요한 인원(대기 기준을 지키는 가장 적은 인원)을 찾았어요.",
            f"바쁜 시간은 최대 2구간이에요. 첫 구간은 주문이 가장 몰린 때, 둘째 구간은 시간당 주문이 하루 평균의 "
            f"{PEAK2_MIN_RATIO:g}배 이상이고 첫 구간과 겹치지 않는 때예요.",
            f"바쁜 시간에만 사람을 더해 30번씩 돌렸어요. 한 명 더할 때 바쁜 시간 대기가 {min_gain:g}초 넘게 줄면 추천안에 넣었어요.",
            "바쁜 시간 대기는 그 구간 시간대 중 가장 긴 대기예요(주문 후 받기, 10명 중 9명이 받는 시간, 30번 평균).",
            "세 안은 짧은 근무조(3.5~5시간)로 덮고 휴게를 넣어 다시 확인한 뒤, 모두 주 15시간 미만이 되게 명단에 배정했어요.",
            "추천안은 긴 근무조(최대 8시간)로 주휴를 주는 경우와도 비교했어요.",
            f"못 채운 자리는 주 {UNDER_15H_MAX_HOURS:g}시간씩 일하는 알바로 채운다고 보고 더 필요한 사람 수를 어림했어요.",
            "안마다 주간 인건비는 근무표 전체 유급시간 × 시급이에요(못 채운 자리도 누군가 일한다고 봄). 주휴 비교는 배정된 사람의 주휴수당을 더했어요.",
            "계획 근무표이며 실제 근무 기록이 아니에요. 보험·가산수당은 빼고 계산했어요.",
        ],
    }
