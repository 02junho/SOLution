"""일주일 근무표: 요일별 근무조(하루 근무표 D의 결과)를 직원 명단에 배정한다 (운영 2번 확장 E).

입력
- days: 요일별 근무조(시작·끝·휴게). 사장님 근무는 빼고 직원 자리만 보낸다.
- workers: 명단(이름, 시급, 연소자, 요일별 가능 시간, 주 최대 근무시간).
- weekly_mode: UNDER_15H(모두 주 15시간 미만으로) / WITH_HOLIDAY_PAY(주휴 포함, 적은 인원으로) / COMPARE(둘 다).

배정(정수 계획법, PuLP + HiGHS. 같은 입력이면 늘 같은 결과)
- 지킬 것: 그 요일 가능 시간 안, 한 사람은 하루 한 근무, 주 최대 근무시간 안.
  연소자는 하루 실제 근무 7시간·주 35시간, 22시~06시 근무 불가(근로기준법 제69조·제70조).
  UNDER_15H는 각자 주 실제 근무 15시간 미만.
- 고르는 순서: ① 못 채운 시간이 가장 적게 ② 일하는 사람이 가장 적게 ③ (주휴 포함) 주간 인건비가 가장 적게,
  (15시간 미만) 사람마다 근무시간 차이가 가장 적게.
- 넣을 사람이 없으면 못 채운 자리로 남긴다(지어내지 않는다).

주휴수당: 주 실제 근무 15시간 이상이면 (주 근무시간 ÷ 40, 최대 1) × 8 × 시급. 노동 쪽 비용 계산(cost.py)과 같은 식이다.
개근·재직을 가정한 계획 금액이며 실제 정산이 아니다.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

DAYS = ("MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN")
DAY_LABEL = dict(zip(DAYS, ("월", "화", "수", "목", "금", "토", "일")))
MODES = ("UNDER_15H", "WITH_HOLIDAY_PAY", "COMPARE")
HOLIDAY_PAY_FROM = 15 * 60
MINOR_DAY = 7 * 60
MINOR_WEEK = 35 * 60
MINOR_NIGHT = (22 * 60, 6 * 60)
TIME_LIMIT_SEC = 10
# 주 15시간 미만 안의 근무조 길이(머무는 시간, 시간). 짧은 조 3.5시간 ~ 긴 조 7.5시간(= 7시간 근무 + 휴게 30분).
# 한 사람이 7시간씩 이틀(14시간)까지 들어갈 수 있다. 11.22 측정: 최대 5시간일 때보다 근무조끼리 겹치는 시간이 줄어
# 대기는 같고 인건비가 15~16% 적었다(바쁜 예시·상권 예시 가게). 추천 근무표·일주일 근무표가 같이 쓴다.
UNDER_15H_SHIFTS = {"long_shift_hours": 7.5, "short_shift_hours": 3.5}


def _min(t: str) -> int:
    if not isinstance(t, str) or len(t) != 5 or t[2] != ":":
        raise ValueError(f"시각은 HH:MM이에요: {t}")
    h, m = int(t[:2]), int(t[3:])
    if not 0 <= h <= 23 or not 0 <= m < 60:
        raise ValueError(f"시각은 HH:MM이에요: {t}")
    return h * 60 + m


def _won(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _slots(days) -> list[dict]:
    if not isinstance(days, list) or not days:
        raise ValueError("요일별 근무조(days)가 필요해요.")
    out = []
    seen = set()
    for d in days:
        day = d.get("day") if isinstance(d, dict) else None
        if day not in DAYS or day in seen:
            raise ValueError("요일은 MON~SUN을 한 번씩만 보내 주세요.")
        seen.add(day)
        for i, s in enumerate(d.get("shifts") or [], start=1):
            start, end = _min(s["start_time"]), _min(s["end_time"])
            if start >= end:
                raise ValueError(f"{DAY_LABEL[day]}요일 근무조 시간이 거꾸로예요.")
            rest = sum(_min(b["end_time"]) - _min(b["start_time"]) for b in s.get("breaks") or [])
            out.append(
                {
                    "slot_id": f"{day}-{i}",
                    "day": day,
                    "start_time": s["start_time"],
                    "end_time": s["end_time"],
                    "breaks": list(s.get("breaks") or []),
                    "start": start,
                    "end": end,
                    "work_min": end - start - rest,
                }
            )
    return out


def _workers(workers) -> list[dict]:
    if not isinstance(workers, list) or not workers or len(workers) > 20:
        raise ValueError("직원 명단은 1~20명이에요.")
    out = []
    keys = set()
    for w in workers:
        key = w.get("worker_key")
        if not isinstance(key, str) or not key or key in keys:
            raise ValueError("직원 이름(worker_key)은 비어 있지 않고 겹치지 않아야 해요.")
        keys.add(key)
        wage = w.get("hourly_wage_krw")
        if type(wage) not in (int, float) or wage <= 0:
            raise ValueError(f"{key}의 시급이 필요해요.")
        available = {}
        for day, span in (w.get("available") or {}).items():
            if day not in DAYS or not isinstance(span, (list, tuple)) or len(span) != 2:
                raise ValueError(f"{key}의 가능 시간은 요일별 [시작, 끝]이에요.")
            a, b = _min(span[0]), _min(span[1])
            if a >= b:
                raise ValueError(f"{key}의 {DAY_LABEL[day]}요일 가능 시간이 거꾸로예요.")
            available[day] = (a, b)
        cap = w.get("max_weekly_hours", 40)
        if type(cap) not in (int, float) or not 0 < cap <= 52:
            raise ValueError(f"{key}의 주 최대 근무시간은 0~52시간이에요.")
        out.append(
            {
                "worker_key": key,
                "name": w.get("name") or key,
                "wage": Decimal(str(wage)),
                "is_minor": bool(w.get("is_minor")),
                "available": available,
                "cap_min": int(cap * 60),
            }
        )
    return out


def _eligible(worker, slot, mode) -> bool:
    span = worker["available"].get(slot["day"])
    if span is None or not (span[0] <= slot["start"] and slot["end"] <= span[1]):
        return False
    if slot["work_min"] > worker["cap_min"]:
        return False
    if mode == "UNDER_15H" and slot["work_min"] >= HOLIDAY_PAY_FROM:
        return False
    if worker["is_minor"]:
        if slot["work_min"] > MINOR_DAY or slot["end"] > MINOR_NIGHT[0] or slot["start"] < MINOR_NIGHT[1]:
            return False
    return True


def _solve(slots, workers, mode):
    """자리 → 사람 배정을 한 번에 푼다. 반환: [(slot, worker_key)], 최적 여부."""
    import pulp

    prob = pulp.LpProblem("weekly_roster", pulp.LpMinimize)
    x = {}
    for si, slot in enumerate(slots):
        for wi, worker in enumerate(workers):
            if _eligible(worker, slot, mode):
                x[si, wi] = prob.add_variable(f"x_{si}_{wi}", cat="Binary")
    used = {wi: prob.add_variable(f"used_{wi}", cat="Binary") for wi in range(len(workers))}
    minutes = {
        wi: pulp.lpSum(slots[si]["work_min"] * v for (si, w), v in x.items() if w == wi) for wi in range(len(workers))
    }
    for si in range(len(slots)):
        prob += pulp.lpSum(v for (s_, _), v in x.items() if s_ == si) <= 1, f"slot_{si}"
    for wi, worker in enumerate(workers):
        for day in DAYS:
            same_day = [v for (si, w), v in x.items() if w == wi and slots[si]["day"] == day]
            if len(same_day) > 1:
                prob += pulp.lpSum(same_day) <= 1, f"one_a_day_{wi}_{day}"
        cap = worker["cap_min"]
        if mode == "UNDER_15H":
            cap = min(cap, HOLIDAY_PAY_FROM - 1)
        if worker["is_minor"]:
            cap = min(cap, MINOR_WEEK)
        prob += minutes[wi] <= cap, f"cap_{wi}"
        for (si, w), v in x.items():
            if w == wi:
                prob += v <= used[wi], f"used_{si}_{wi}"
    unfilled = pulp.lpSum(slot["work_min"] for slot in slots) - pulp.lpSum(
        slots[si]["work_min"] * v for (si, _), v in x.items()
    )
    people = pulp.lpSum(used.values())
    # 2단계 우선순위: 사람 수 ≫ 비용·고르게
    big_people = 100_000
    if mode == "WITH_HOLIDAY_PAY":
        # 주휴: 주 15시간 이상이면 (분 ÷ 60 ÷ 40 × 8 × 시급) = 분 × 시급 ÷ 300. 15시간 넘었는지를 z로 나눈다.
        tail = []
        for wi, worker in enumerate(workers):
            z = prob.add_variable(f"holiday_{wi}", cat="Binary")
            paid = prob.add_variable(f"holiday_min_{wi}", lowBound=0)
            big = worker["cap_min"] + 1
            prob += minutes[wi] <= HOLIDAY_PAY_FROM - 1 + big * z, f"holiday_on_{wi}"
            prob += paid >= minutes[wi] - big * (1 - z), f"holiday_paid_{wi}"
            prob += paid <= big * z, f"holiday_off_{wi}"
            wage = float(worker["wage"])
            tail.append(minutes[wi] * wage / 60 + paid * wage / 300)
        # 비용(원)을 1만 원 단위로 줄여 사람 1명보다 작게 둔다
        secondary = pulp.lpSum(tail) / 10_000
    else:
        top = prob.add_variable("most_minutes", lowBound=0)
        for wi in range(len(workers)):
            prob += top >= minutes[wi] - HOLIDAY_PAY_FROM * (1 - used[wi]), f"top_{wi}"
        secondary = top / 100
    # 두 단계로 푼다. 1) 못 채운 시간만 최소로. 2) 그 값을 지키면서 사람 수 ≫ 비용·고르게.
    # 한 번에 가중치로 풀면 시간 한도 안에 못 끝났을 때 사람이 놀고 자리가 비는 답이 남을 수 있다.
    solver = lambda: pulp.HiGHS(msg=False, timeLimit=TIME_LIMIT_SEC, gapRel=0, gapAbs=0, threads=1)  # noqa: E731
    pick = lambda: [  # noqa: E731
        (slots[si], workers[wi]["worker_key"]) for (si, wi), v in x.items() if v.value() and round(v.value()) == 1
    ]
    prob.setObjective(unfilled)
    first = prob.solve(solver())
    if not first.has_solution:
        return [], False
    placed = pick()
    best = sum(slot["work_min"] for slot in slots) - sum(slot["work_min"] for slot, _ in placed)
    prob += unfilled <= best, "keep_filled"
    # 조건이 똑같은 사람(가능 시간·한도·시급·연소자)은 바꿔 놓아도 같은 답이라, 2단계에서만 앞 사람이 더 일하게 순서를 정해
    # 찾을 곳을 줄인다(1단계에 넣으면 오히려 느려진다).
    profile = lambda w: (tuple(sorted(w["available"].items())), w["cap_min"], w["wage"], w["is_minor"])  # noqa: E731
    for wi in range(1, len(workers)):
        twin = next((wj for wj in range(wi - 1, -1, -1) if profile(workers[wj]) == profile(workers[wi])), None)
        if twin is not None:
            prob += minutes[twin] >= minutes[wi], f"twin_{twin}_{wi}"
    prob.setObjective(big_people * people + secondary)
    second = prob.solve(solver())
    if not second.has_solution:
        return placed, False
    return pick(), first.status == second.status == pulp.LpSolveStatus.Optimal


def assign(slots: list[dict], workers: list[dict], mode: str) -> dict:
    by_key = {w["worker_key"]: w for w in workers}
    placed, optimal = _solve(slots, workers, mode)
    taken = {id(s) for s, _ in placed}
    unfilled = [s for s in slots if id(s) not in taken]
    week = {w["worker_key"]: 0 for w in workers}
    days_used = {w["worker_key"]: set() for w in workers}
    for slot, key in placed:
        week[key] += slot["work_min"]
        days_used[key].add(slot["day"])

    rows = []
    for w in workers:
        minutes = week[w["worker_key"]]
        hours = Decimal(minutes) / 60
        base = _won(hours * w["wage"])
        eligible = minutes >= HOLIDAY_PAY_FROM
        holiday = _won(min(hours, Decimal(40)) / 40 * 8 * w["wage"]) if eligible else 0
        rows.append(
            {
                "worker_key": w["worker_key"],
                "name": w["name"],
                "is_minor": w["is_minor"],
                "days": [d for d in DAYS if d in days_used[w["worker_key"]]],
                "weekly_work_hours": float(round(hours, 2)),
                "weekly_holiday_pay": eligible,
                "base_wage_krw": base,
                "holiday_pay_krw": holiday,
                "weekly_cost_krw": base + holiday,
            }
        )
    key = lambda s: (DAYS.index(s["day"]), s["start"])  # noqa: E731
    return {
        "mode": mode,
        "optimal": optimal,
        "assignments": [
            {
                "slot_id": s["slot_id"],
                "day": s["day"],
                "worker_key": k,
                "name": by_key[k]["name"],
                "start_time": s["start_time"],
                "end_time": s["end_time"],
                "breaks": s["breaks"],
                "work_hours": s["work_min"] / 60,
            }
            for s, k in sorted(placed, key=lambda p: key(p[0]))
        ],
        "unfilled": [
            {"slot_id": s["slot_id"], "day": s["day"], "start_time": s["start_time"], "end_time": s["end_time"],
             "breaks": s["breaks"], "work_hours": s["work_min"] / 60}
            for s in sorted(unfilled, key=key)
        ],
        "workers": rows,
        "people_used": sum(1 for r in rows if r["days"]),
        "weekly_cost_krw": sum(r["weekly_cost_krw"] for r in rows),
        "holiday_pay_krw": sum(r["holiday_pay_krw"] for r in rows),
    }


def new_hires(unfilled: list[dict], cap_hours: float, prefix: str = "새 직원", wage: float | None = None) -> list[dict]:
    """명단으로 못 채운 자리를 새로 뽑을 알바에 나눠 넣는다(추천 근무표 6번: 결과가 원하는 근무표를 끝까지 채워 보여 주기).

    배정과 같은 규칙: 한 사람은 하루 한 근무, 주 근무시간은 cap_hours 이하(15시간 미만 안이면 14.5).
    긴 자리부터, 넣을 수 있는 사람 중 앞 사람에게(같은 입력이면 늘 같은 결과). 가능 시간은 새로 뽑는 사람이라 따지지 않는다.
    wage(시급)가 있으면 주 예상 급여(base_wage_krw = 주 근무시간 × 시급, 주휴 없음)도 붙인다. 배정한 직원과 같은 식(_won).
    반환: [{"worker_key": "NEW_1", "name": "새 직원 1", "weekly_work_hours", "base_wage_krw"?, "assignments": [자리...]}]
    """
    cap = round(cap_hours * 60)
    order = sorted(unfilled, key=lambda u: (-u["work_hours"], DAYS.index(u["day"]), u["start_time"]))
    hires: list[dict] = []
    for slot in order:
        minutes = round(slot["work_hours"] * 60)
        if minutes > cap:
            raise ValueError(f"{DAY_LABEL[slot['day']]}요일 {slot['start_time']} 자리는 한 사람 주 한도보다 길어요.")
        home = next((h for h in hires if slot["day"] not in h["days"] and h["minutes"] + minutes <= cap), None)
        if home is None:
            n = len(hires) + 1
            home = {"worker_key": f"NEW_{n}", "name": f"{prefix} {n}", "days": set(), "minutes": 0, "slots": []}
            hires.append(home)
        home["days"].add(slot["day"])
        home["minutes"] += minutes
        home["slots"].append(slot)
    hires = _group_hires(hires, cap) or hires
    by_day = lambda u: (DAYS.index(u["day"]), u["start_time"])  # noqa: E731
    return [
        {
            "worker_key": h["worker_key"],
            "name": h["name"],
            "weekly_work_hours": h["minutes"] / 60,
            **({"base_wage_krw": _won(Decimal(h["minutes"]) / 60 * Decimal(str(wage)))} if wage else {}),
            "assignments": [{**u, "worker_key": h["worker_key"], "name": h["name"]} for u in sorted(h["slots"], key=by_day)],
        }
        for h in hires
    ]


# 새로 뽑을 직원 묶기: 채용 공고로 쓰기 쉽게 이어지는 요일·같은 시작 시각끼리(사람 수는 늘리지 않는다).
HIRE_RUN_PENALTY = 30  # 한 사람 근무가 끊긴 덩어리 하나마다(화·금이면 덩어리 2개)
HIRE_START_PENALTY = 5  # 한 사람의 시작 시각 가짓수마다(07:00과 11:00에 섞여 시작하면 2가지)
HIRE_GROUP_MAX_ROUNDS = 500  # 고칠 곳이 남아도 이만큼만(무한히 돌지 않게)


def _hire_score(group: list[dict]) -> int:
    """한 사람 묶음의 불편 점수: 끊긴 요일 덩어리 수와 시작 시각 가짓수(작을수록 공고 내기 쉽다)."""
    if not group:
        return 0
    days = sorted(DAYS.index(u["day"]) for u in group)
    runs = 1 + sum(1 for a, b in zip(days, days[1:]) if b - a > 1)
    return HIRE_RUN_PENALTY * runs + HIRE_START_PENALTY * len({u["start_time"] for u in group})


def _group_hires(greedy: list[dict], cap: int) -> list[dict] | None:
    """앞에서 차례로 넣은 묶음(greedy)을 같은 사람 수 안에서, 이어지는 요일·같은 시작 시각이 되게 다시 묶는다.

    규칙은 같다: 한 사람 하루 한 근무, 주 근무시간 cap분 이하. 자리 하나 옮기기·두 자리 맞바꾸기를 점수가 줄어드는 동안
    정해진 순서로 되풀이한다(같은 입력이면 늘 같은 결과, 자리 수십 개도 금방). 근무시간 합계가 같아 인건비는 그대로다.
    """
    if len(greedy) < 2:
        return None
    groups = [list(h["slots"]) for h in greedy]
    mins = lambda g: sum(round(u["work_hours"] * 60) for u in g)  # noqa: E731
    fits = lambda g, u: u["day"] not in {v["day"] for v in g} and mins(g) + round(u["work_hours"] * 60) <= cap  # noqa: E731
    for _ in range(HIRE_GROUP_MAX_ROUNDS):
        better = False
        for gi in range(len(groups)):
            for u in list(groups[gi]):
                for gj in range(len(groups)):
                    if gj == gi:
                        continue
                    rest = [v for v in groups[gi] if v is not u]
                    # 옮기기
                    if fits(groups[gj], u):
                        before = _hire_score(groups[gi]) + _hire_score(groups[gj])
                        if _hire_score(rest) + _hire_score(groups[gj] + [u]) < before:
                            groups[gi], groups[gj] = rest, groups[gj] + [u]
                            better = True
                            break
                    # 맞바꾸기
                    for v in list(groups[gj]):
                        other = [w for w in groups[gj] if w is not v]
                        if fits(rest, v) and fits(other, u):
                            before = _hire_score(groups[gi]) + _hire_score(groups[gj])
                            if _hire_score(rest + [v]) + _hire_score(other + [u]) < before:
                                groups[gi], groups[gj] = rest + [v], other + [u]
                                better = True
                                break
                    if better:
                        break
                if better:
                    break
            if better:
                break
        if not better:
            break
    groups = sorted((g for g in groups if g), key=lambda g: min((DAYS.index(u["day"]), u["start_time"]) for u in g))
    prefix = greedy[0]["name"].rsplit(" ", 1)[0]
    return [
        {"worker_key": f"NEW_{n}", "name": f"{prefix} {n}", "days": {u["day"] for u in g}, "minutes": mins(g), "slots": g}
        for n, g in enumerate(groups, 1)
    ]


def plan(body: dict) -> dict:
    if not isinstance(body, dict):
        raise ValueError("JSON 객체를 보내 주세요.")
    mode = body.get("weekly_mode", "COMPARE")
    if mode not in MODES:
        raise ValueError("weekly_mode는 UNDER_15H·WITH_HOLIDAY_PAY·COMPARE 중 하나예요.")
    slots = _slots(body.get("days"))
    workers = _workers(body.get("workers"))
    modes = ("UNDER_15H", "WITH_HOLIDAY_PAY") if mode == "COMPARE" else (mode,)
    results = [assign(slots, workers, m) for m in modes]
    return {
        "model_version": "operation.weekly_roster.v1",
        "weekly_mode": mode,
        "slot_count": len(slots),
        "results": results,
        "assumptions": [
            "요일별 근무조는 하루 근무표(시간대별 필요 인원 → 근무조 → 휴게 → 확인)에서 왔어요. 요일마다 그 요일 평균 손님으로 만들었어요.",
            "배정은 정수 계획법(PuLP)으로 한 번에 풀었어요: 못 채운 시간이 가장 적게 → 일하는 사람이 가장 적게 → "
            "(주휴 포함) 주간 인건비가 가장 적게, (15시간 미만) 사람마다 근무시간이 고르게. 한 사람은 하루에 한 근무만 해요.",
            "주 15시간 미만으로: 모두 주 실제 근무 15시간 미만이 되게 나눴어요(주휴수당이 생기지 않음).",
            "주휴 포함: 주 최대 근무시간까지 쓸 수 있게 해서 인원을 줄였어요.",
            "주휴수당 = (주 근무시간 ÷ 40, 최대 1) × 8 × 시급, 주 15시간 이상일 때(개근·재직 가정). 노동 쪽 비용 계산과 같은 식이에요.",
            "연소자는 하루 7시간·주 35시간, 22시~06시 근무를 넘지 않게 넣었어요(근로기준법 제69조·제70조, 합의 연장은 쓰지 않음).",
            "못 채운 자리는 지어내지 않고 남겨요. 사람을 더 구하거나 가능 시간을 넓혀야 해요.",
            "계획 금액이며 실제 정산이 아니에요. 보험·가산수당은 빼고 계산했어요.",
        ],
    }
