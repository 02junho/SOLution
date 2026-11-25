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
5. 세 안을 주 15시간 미만용 근무조(3.5~7.5시간, weekly_roster.UNDER_15H_SHIFTS)로 덮고 휴게를 넣어 다시 확인한다.
   추천안은 긴 근무조(주휴 포함)로도 만들어 비교한다(compare_holiday_pay=false면 건너뛴다: 쉬운 화면은 이 비교를 안 보여 줘서 계산을 줄인다).
주 단위로는 안마다 요일별 직원 자리를 명단에 배정한다(weekly_roster). 저장하지 않는다.
"""

from __future__ import annotations

import copy
import logging
import time
import multiprocessing
import os
import threading
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date

from app.schemas.simulation import ROSTER_OPTIONS_REPETITIONS

from . import day_cache, weekly_roster, roster_break_refinement
from .roster_recommendation import recommended_choice
from .daily_roster import _build, _cost, _count_rows, _prepare, _rules
from .parallel import worker_count
from .day_window import day, from_scenario, using

# ---------------------------------------------------------------- 진행 상황(요일이 끝나는 대로 화면에 먼저 보이기)
# 요청 키(progress_key)마다 끝난 요일의 짧은 요약을 둔다. ai-server는 프로세스 하나(uvicorn 1개)라 메모리로 충분하다.
# 결과 전체가 아니라 화면 진행 표시에 쓸 요약만 둔다(주간 배정은 모든 요일이 끝나야 해서 근무표는 마지막에 나온다).
PROGRESS_KEEP = 50
_progress: dict[str, dict] = {}
_progress_lock = threading.Lock()


PROGRESS_KEY_MAX = 128  # Spring이 "업무번호:요청키"(최대 120자)로 보낸다


def _progress_start(key: str | None, days: list[str]) -> dict | None:
    """이번 실행의 진행 기록을 만들어 돌려준다. 같은 키로 다시 계산하면 새 기록으로 바뀌고, 앞 실행은 자기 기록에만 쓴다."""
    if not key:
        return None
    entry = {"total": len(days), "days": {}, "order": days}
    with _progress_lock:
        _progress.pop(key, None)  # 다시 넣어 가장 최근 것으로
        _progress[key] = entry
        while len(_progress) > PROGRESS_KEEP:  # 오래된 것부터 지운다(dict는 넣은 순서를 지킨다)
            _progress.pop(next(iter(_progress)))
    return entry


def _progress_day(entry: dict | None, name: str, result: dict | None, err: str | None) -> None:
    if entry is None:
        return
    with _progress_lock:
        if name in entry["days"]:
            return
        if err or not result:
            entry["days"][name] = {"failed": True}
            return
        k = result["picks"]["RECOMMENDED"]
        entry["days"][name] = {
            "windows": result["windows"],
            "extra": k,
            "peak_wait_sec": result["ladder"][k]["peak_wait_sec"],
        }


def progress(key: str) -> dict | None:
    """끝난 요일 수와 요일별 요약(추천안: 바쁜 시간, 더한 인원, 가장 긴 대기). 모르는 키면 None."""
    with _progress_lock:
        entry = _progress.get(key)
        if entry is None:
            return None
        return {"total": entry["total"], "done": len(entry["days"]), "order": list(entry["order"]),
                "days": {n: dict(entry["days"][n]) for n in entry["order"] if n in entry["days"]}}


# 추천 근무표의 하루 반복 수(손님을 몇 번 새로 뽑아 돌릴지). 1번(세 안 비교)의 기본 30번과 따로 둔다.
ROSTER_REPETITIONS = ROSTER_OPTIONS_REPETITIONS
log = logging.getLogger("uvicorn.error")
from .simulation_common import summarize

MAX_EXTRA = 3
MIN_GAIN_SEC = 30
PEAK2_MIN_RATIO = 1.3
# 주 15시간 미만으로 나눌 때 한 사람이 일할 수 있는 최대(30분 단위).
UNDER_15H_MAX_HOURS = 14.5
SHORT_RULES = weekly_roster.UNDER_15H_SHIFTS
LONG_RULES: dict = {}
OPTIONS = (
    ("SAVE", "인건비 절약 근무표"),
    ("RECOMMENDED", "균형 근무표"),
    ("ROOMY", "여유 근무표"),
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
        "repetitions": roster["repetitions"],
        "peak_wait_sec": _worst(waits),
        "by_window_sec": waits,
    }


def day_options(body: dict, engine: str = "simpy", min_gain: float = MIN_GAIN_SEC, holiday: bool = True) -> dict:
    """한 요일: 바쁜 시간, 더하기 비교, 세 안 근무표(짧은 조) + 추천안 긴 조(holiday=True일 때만)."""
    spec = body.get("scenario") if isinstance(body, dict) else None
    with using(from_scenario(spec)):
        ctx = _prepare(body, engine)
        windows = busy_windows(ctx["scn"])
        ctx["break_refine"] = lambda shifts, context, need: roster_break_refinement.refine(
            shifts, context, need, windows
        )
        ladder = _ladder(ctx, windows, min_gain)
        picks = _pick(ladder, min_gain)
        short = _rules({**body, "roster_rules": {**(body.get("roster_rules") or {}), **SHORT_RULES}}, ctx["minor"])
        built = {}
        for k in sorted(set(picks.values())):
            built[k] = _view(_build({**ctx, "counts": ladder[k]["counts"]}, short), windows)
        holiday_view = None
        if holiday:
            long_ = _rules({**body, "roster_rules": {**(body.get("roster_rules") or {}), **LONG_RULES}}, ctx["minor"])
            holiday_view = _view(_build({**ctx, "counts": ladder[picks["RECOMMENDED"]]["counts"]}, long_), windows)
        return {
            "windows": [{"start_time": w["start_time"], "end_time": w["end_time"]} for w in windows],
            "required_staff": ctx["counts"],
            "slots": list(day().slots),
            "ladder": [{k: v for k, v in step.items() if k != "counts"} for step in ladder],
            "picks": picks,
            "rosters": {str(k): v for k, v in built.items()},
            "holiday_roster": holiday_view,
        }


def _day_job(args):
    day_name, roster_body, engine, min_gain, holiday = args
    try:
        return day_name, day_options(roster_body, engine, min_gain, holiday), None
    except ValueError as exc:
        return day_name, None, str(exc).removeprefix("NEEDS_INPUT:").strip()


def _job_key(job):
    """요일 이름과 시급은 빼고 조건만으로 키를 만든다.

    - 월·화가 조건이 같으면 한 번만 계산한다.
    - 시급은 손님 대기(시뮬레이션)에 쓰이지 않고 인건비에만 들어간다. 그래서 시급만 바꾸면 기억한 근무표를 그대로 쓰고
      인건비만 다시 계산한다(_fit).
    """
    _, roster_body, engine, min_gain, holiday = job
    sim_body = {k: v for k, v in roster_body.items() if k != "hourly_wage_krw"}
    # 근무조 규칙도 키에 넣는다(규칙을 바꾼 뒤 예전 규칙으로 계산한 기억을 꺼내지 않게).
    return day_cache.key("roster_options.break_refinement.v3", sim_body, engine, min_gain, holiday, SHORT_RULES, LONG_RULES)


def _wage(job):
    return job[1].get("hourly_wage_krw")


def _fit(job, stored):
    """기억해 둔 요일 결과를 이 요청의 시급에 맞춘다. 근무조·대기는 그대로, 인건비만 다시 계산한다.

    stored = {"wage": 계산할 때 시급, "day": day_options 결과}. 돌려주는 값은 _day_job과 같은 (요일, 결과, 오류).
    """
    name, roster_body = job[0], job[1]
    result = copy.deepcopy(stored["day"])
    wage = _wage(job)
    if wage == stored["wage"]:
        return name, result, None
    try:
        if type(wage) not in (int, float) or wage <= 0:
            raise ValueError("NEEDS_INPUT: 직원 시급이 필요해요.")
        business_date = date.fromisoformat(roster_body["business_date"]) if roster_body.get("business_date") else date.today()
        minor = bool(roster_body.get("is_staff_minor", False))
        views = list(result["rosters"].values()) + ([result["holiday_roster"]] if result.get("holiday_roster") else [])
        for view in views:
            view["cost"] = _cost(view["shifts"], wage, business_date, minor)
    except ValueError as exc:
        return name, None, str(exc).removeprefix("NEEDS_INPUT:").strip()
    return name, result, None


# 미리 계산 프로세스의 우선순위(nice). 높을수록 양보한다. 진짜 계산과 겹치면 OS가 진짜 계산에 CPU를 먼저 준다.
BACKGROUND_NICE = 10


def _lower_priority():
    try:
        os.nice(BACKGROUND_NICE)
    except (AttributeError, OSError):
        pass  # Windows 등 nice가 없으면 그대로 돈다


def _compute(jobs, background=False, on_done=None):
    """요일 계산. background(미리 계산)면 계산 프로세스를 낮은 우선순위로 띄워 진짜 계산에 양보한다.

    프로세스 수는 진짜 계산과 같게 둔다: 진짜 계산이 미리 계산 중인 요일을 이어받으면 그 속도로 끝나야 하고,
    겹치는 일이 없으면 OS가 진짜 계산에 CPU를 먼저 준다.
    """
    done = on_done or (lambda i, r: None)  # 요일 하나가 끝날 때마다 부른다(진행 상황). 결과 순서는 jobs 그대로.
    count = worker_count(len(jobs))
    if count <= 1 and not background:
        out = []
        for i, j in enumerate(jobs):
            out.append(_day_job(j))
            done(i, out[-1])
        return out
    out = [None] * len(jobs)
    delivered = set()  # done으로 이미 넘긴 요일 번호
    try:
        context = multiprocessing.get_context("spawn")
        initializer = _lower_priority if background else None
        with ProcessPoolExecutor(max_workers=count, mp_context=context, initializer=initializer) as pool:
            futures = {pool.submit(_day_job, j): i for i, j in enumerate(jobs)}
            for f in as_completed(futures):
                i = futures[f]
                out[i] = f.result()
                delivered.add(i)
                done(i, out[i])
            return out
    except (OSError, RuntimeError):
        # 프로세스를 못 띄우거나 중간에 깨짐: 이미 넘긴 요일은 그대로 두고 남은 요일만 여기서 계산한다(두 번 넘기지 않게).
        for i, j in enumerate(jobs):
            if i in delivered:
                continue
            out[i] = _day_job(j)
            done(i, out[i])
        return out


def _run_days(jobs, background=False, on_day=None):
    """기억해 둔 요일은 꺼내 쓰고, 나머지만 계산한다.

    - 같은 조건 요일이 여럿이면 하나만 계산한다(시급만 다르면 인건비만 다시 계산).
    - 다른 요청(예: 미리 계산)이 지금 같은 조건을 계산 중이면 새로 돌리지 않고 그 계산이 끝나기를 기다려 이어받는다.
    - 기억에는 {"wage": 계산할 때 시급, "day": 결과}를 둔다. 실패한 요일은 기억하지 않는다.
    """
    tell = on_day or (lambda name, result, err: None)  # 요일 하나가 준비될 때마다(기억·계산·이어받기 모두)
    started = time.perf_counter()
    cache_hits = 0
    results, mine, waiting = {}, {}, {}
    for job in jobs:
        k = _job_key(job)
        hit = day_cache.get(k)
        if hit is not None:
            cache_hits += 1
            results[job[0]] = _fit(job, hit)
            tell(*results[job[0]])  # 시급을 맞춘 결과(맞추다 실패하면 그 오류)를 그대로 알린다
            continue
        if k in mine:
            mine[k][1].append(job)
            continue
        claimed, future = day_cache.claim(k)
        if claimed:
            # 기억을 본 뒤 표시하기 전 사이에 다른 요청이 끝냈을 수 있다.
            late = day_cache.get(k)
            if late is not None:
                cache_hits += 1
                day_cache.release(k, future, value=late)
                results[job[0]] = _fit(job, late)
                tell(*results[job[0]])
                continue
            mine[k] = (future, [job])
        else:
            waiting.setdefault(k, (future, []))[1].append(job)
    if mine:
        entries = list(mine.items())
        released = set()

        def finish(i, out):
            # 요일 하나가 끝나는 대로 기억에 넣고 기다리던 다른 요청(예: 미리 계산을 이어받은 진짜 계산)에 바로 넘긴다.
            # 예전에는 모든 요일이 끝난 뒤에 한꺼번에 넘겨서, 이어받은 쪽 진행 표시가 끝까지 0이었다.
            k, (future, group) = entries[i]
            _, result, err = out
            stored = None if err else {"wage": _wage(group[0]), "day": result}
            if stored:
                day_cache.put(k, stored)
            day_cache.release(k, future, value=stored)
            released.add(k)
            for job in group:
                results[job[0]] = _fit(job, stored) if stored else (job[0], None, err)
                tell(*results[job[0]])

        try:
            _compute([group[0] for _, (_, group) in entries], background, on_done=finish)
        except BaseException as exc:
            for k, (future, _) in entries:
                if k not in released:
                    day_cache.release(k, future, error=exc)
            raise
    # 이어받기는 끝나는 순서대로(진행 표시가 요일 순서를 기다리지 않게)
    by_future = {future: k for k, (future, _) in waiting.items()}
    for done_future in as_completed(list(by_future)):
        k = by_future[done_future]
        future, group = waiting[k]
        # 이어받기: 다른 요청이 계산 중인 요일. 그쪽이 실패하면(프로세스 오류·계산 오류) 여기서 직접 계산한다.
        try:
            stored = future.result()
        except Exception:
            stored = None
        if stored is None:
            _, result, err = _compute([group[0]], background)[0]
            if err:
                for job in group:
                    results[job[0]] = (job[0], None, err)
                    tell(job[0], None, err)
                continue
            stored = {"wage": _wage(group[0]), "day": result}
            day_cache.put(k, stored)
        for job in group:
            results[job[0]] = _fit(job, stored)
            tell(*results[job[0]])
    log.info("roster days background=%s days=%d cache_hits=%d new_unique=%d joined_unique=%d repetitions=%s elapsed=%.2fs",
             background, len(jobs), cache_hits, len(mine), len(waiting),
             sorted({j[1]["repetitions"] for j in jobs}), time.perf_counter() - started)
    return [results[job[0]] for job in jobs]


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


def _hire_wage(days):
    """새로 뽑을 알바의 시급: 요일 조건의 직원 시급(쉬운 화면은 요일마다 같다). 없으면 None(급여 칸 없이)."""
    wages = [d["roster"].get("hourly_wage_krw") for d in days if isinstance(d.get("roster"), dict)]
    return next((w for w in wages if type(w) in (int, float) and w > 0), None)


def _shortfall(weekly, hires):
    """못 채운 자리와, 그 자리를 주 15시간 미만 새 알바에 실제로 나눠 넣었을 때 몇 명이 더 필요한지(new_hires 줄 수와 같다)."""
    hours = sum(u["work_hours"] for u in weekly["unfilled"])
    return {"unfilled_hours": hours, "more_people_under_15h": len(hires)}


def plan(body: dict, engine: str = "simpy") -> dict:
    days = body.get("days")
    if not isinstance(days, list) or not 1 <= len(days) <= 7:
        raise ValueError("요일별 조건(days)은 1~7개예요.")
    min_gain = body.get("min_gain_sec", MIN_GAIN_SEC)
    if type(min_gain) not in (int, float) or not 10 <= min_gain <= 300:
        raise ValueError("min_gain_sec는 10~300초예요.")
    # 주휴 비교(추천안을 긴 근무조로 한 번 더 짜기). 기본은 한다(실험실). 쉬운 화면은 false로 보내 계산을 줄인다.
    holiday_on = body.get("compare_holiday_pay", True)
    if type(holiday_on) is not bool:
        raise ValueError("compare_holiday_pay는 true/false예요.")
    started = time.perf_counter()
    seen, jobs = set(), []
    for d in days:
        name = d.get("day") if isinstance(d, dict) else None
        if name not in weekly_roster.DAYS or name in seen or not isinstance(d.get("roster"), dict):
            raise ValueError("요일은 MON~SUN을 한 번씩, 각 요일에 roster(하루 근무표 조건)를 보내 주세요.")
        seen.add(name)
        # 반복 수: 따로 안 보냈으면 ROSTER_REPETITIONS(같은 seed에서 30번과 인건비 차이 5% 안팎, 시간 약 35% 덜 듦. 개발기록 65번)
        roster = {"repetitions": ROSTER_REPETITIONS, **d["roster"]}
        # 날짜를 비우면 오늘로 채워 둔다: 요일 기억 키에 날짜가 들어가야 해가 바뀌어(최저시급·노동 규칙 연도) 예전 계산을 꺼내지 않는다.
        roster.setdefault("business_date", date.today().isoformat())
        jobs.append((name, roster, engine, min_gain, holiday_on))
    workers = weekly_roster._workers(body.get("workers"))
    # 미리 계산: 낮은 우선순위 프로세스로 돈다. 결과는 같다.
    background = body.get("background", False)
    if type(background) is not bool:
        raise ValueError("background는 true/false예요.")

    # 진행 상황 키(Spring이 계산 작업의 요청 키를 보낸다). 화면이 계산 중에 끝난 요일부터 보여 준다.
    progress_key = body.get("progress_key")
    if progress_key is not None and (not isinstance(progress_key, str) or not 1 <= len(progress_key) <= PROGRESS_KEY_MAX):
        raise ValueError(f"progress_key는 1~{PROGRESS_KEY_MAX}자예요.")
    entry = _progress_start(progress_key, [j[0] for j in jobs])
    finished = sorted(
        _run_days(jobs, background, on_day=lambda name, result, err: _progress_day(entry, name, result, err)),
        key=lambda r: weekly_roster.DAYS.index(r[0]),
    )
    days_finished_at = time.perf_counter()
    skipped = [{"day": n, "reason": err} for n, _, err in finished if err]
    done = {n: r for n, r, err in finished if not err}

    options = []
    for key, title in OPTIONS:
        views = {n: r["rosters"][str(r["picks"][key])] for n, r in done.items()}
        weekly = _assign(views, workers, "UNDER_15H")
        # 명단으로 못 채운 자리는 새로 뽑을 알바에 나눠 넣어 근무표를 끝까지 채운다(지금 직원 배정은 그대로).
        hires = weekly_roster.new_hires(weekly["unfilled"], UNDER_15H_MAX_HOURS, wage=_hire_wage(days))
        options.append(
            {
                "key": key,
                "title": title,
                "extra_by_day": {n: r["picks"][key] for n, r in done.items()},
                "days": views,
                "weekly": weekly,
                "new_hires": hires,
                "shortfall": _shortfall(weekly, hires),
                "daily_cost_krw": {n: v["cost"]["cash_cost_krw"] for n, v in views.items()},
                # 근무표 전체 인건비(못 채운 자리도 누군가 일한다고 보고). 15시간 미만이라 주휴는 없다.
                "plan_cost_krw": sum(v["cost"]["cash_cost_krw"] for v in views.values()),
                "peak_wait_sec": {n: v["peak_wait_sec"] for n, v in views.items()},
            }
        )
    # 반복 횟수는 요청마다 다를 수 있어 결과에서 읽는다(설명 문장·화면이 같은 숫자를 쓰게).
    reps = next((v["repetitions"] for o in options for v in o["days"].values()), ROSTER_REPETITIONS)
    holiday_compare = None
    if holiday_on:
        holiday_views = {n: r["holiday_roster"] for n, r in done.items()}
        holiday = _assign(holiday_views, workers, "WITH_HOLIDAY_PAY")
        holiday_cost = sum(v["cost"]["cash_cost_krw"] for v in holiday_views.values()) + holiday["holiday_pay_krw"]
        holiday_compare = {"key": "RECOMMENDED", "days": holiday_views, "weekly": holiday, "plan_cost_krw": holiday_cost}
    assignment_finished_at = time.perf_counter()
    recommended_key = recommended_choice(options, skipped)
    finished_at = time.perf_counter()
    log.info("roster total background=%s days=%.2fs assignment=%.2fs total=%.2fs repetitions=%d recommendation=%.6fs recommended_choice_key=%s",
             background, days_finished_at - started, assignment_finished_at - days_finished_at,
             finished_at - started, reps, finished_at - assignment_finished_at, recommended_key)
    return {
        "model_version": "operation.roster_options.v1",
        "recommended_choice_key": recommended_key,
        "min_gain_sec": min_gain,
        "repetitions": reps,
        "skipped_days": skipped,
        "days": {
            n: {"windows": r["windows"], "ladder": r["ladder"], "picks": r["picks"], "slots": r["slots"],
                "required_staff": r["required_staff"]}
            for n, r in done.items()
        },
        "options": options,
        # 주휴 비교를 안 했으면 None(화면은 비교 줄을 숨긴다).
        "holiday_compare": holiday_compare,
        "assumptions": [a for a in [
            "요일마다 그 요일 평균 손님으로 시간대별 꼭 필요한 인원(대기 기준을 지키는 가장 적은 인원)을 찾았어요.",
            f"바쁜 시간은 최대 2구간이에요. 첫 구간은 주문이 가장 몰린 때, 둘째 구간은 시간당 주문이 하루 평균의 "
            f"{PEAK2_MIN_RATIO:g}배 이상이고 첫 구간과 겹치지 않는 때예요.",
            f"바쁜 시간에만 사람을 더해 {reps}번씩 돌렸어요. 한 명 더할 때 바쁜 시간 대기가 {min_gain:g}초 이상 줄면 균형안에 넣었어요.",
            f"바쁜 시간 대기는 그 구간 시간대 중 가장 긴 대기예요(주문 후 받기, 10명 중 9명이 받는 시간, {reps}번 평균).",
            f"세 안은 {SHORT_RULES['short_shift_hours']:g}~{SHORT_RULES['long_shift_hours']:g}시간 근무조(휴게 포함)로 덮고 휴게를 넣어 다시 확인한 뒤, 모두 주 15시간 미만이 되게 명단에 배정했어요.",
            "균형안은 긴 근무조(최대 8시간)로 주휴를 주는 경우와도 비교했어요." if holiday_on else None,
            f"명단으로 못 채운 자리는 새로 뽑을 직원(하루 한 근무, 주 {UNDER_15H_MAX_HOURS:g}시간 이하)에 나눠 넣고, 그 사람 수를 더 필요한 인원으로 셌어요.",
            "안마다 주간 인건비는 근무표 전체 유급시간 × 시급이에요(못 채운 자리도 누군가 일한다고 봄)."
            + (" 주휴 비교는 배정된 사람의 주휴수당을 더했어요." if holiday_on else ""),
            "최종 추천은 세 안의 대기시간·인건비·채용 필요 인원과 목표시간 검증 등을 비교해 정했어요.",
            "계획 근무표이며 실제 근무 기록이 아니에요. 보험·가산수당은 빼고 계산했어요.",
        ] if a],
    }
