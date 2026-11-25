"""하루 근무표 자동 생성 (운영 2번 확장 D).

순서
1. 시간대별 필요 인원: 시간대마다 대기 기준(주문 후 받기까지 손님 90%가 5분 이내, 30번 중 80%)을 지키는 가장 적은
   인원을 앞 시간대부터 찾는다(같은 손님 조건 30번). 앞 시간대는 고정, 뒤 시간대는 넉넉한 인원으로 둔다.
   하루 전체를 다시 돌려 기준을 못 지키면 가장 약한 시간대에 1명씩 더한다.
2. 근무조로 덮기: 사장님이 일하는 시간은 사장님을 1명으로 세고, 남은 필요 인원을 앞에서부터 근무조로 덮는다.
   근무조 길이는 이어서 필요한 시간만큼(짧은 조 최소 4시간 ~ 긴 조 최대 8시간), 30분 단위.
3. 휴게: 법정 휴게 길이(labor 정책: 4시간 이상 30분, 8시간 이상 1시간)를 넣되, 빠져도 필요 인원이 남는 때를
   먼저 고른다(다음으로 매장이 비지 않는 때, 바쁜 시간 밖, 근무 가운데에 가까운 때). 넣은 휴게는 노동 쪽
   배치표 검사(labor.create_schedule)로 다시 확인한다.
4. 검증: 휴게 동안 빠지는 사람까지 반영해 다시 30번 돌린다. 기준을 못 지키면 가장 약한 시간대에 짧은 조를 더하고
   휴게·검증을 다시 한다(최대 MAX_REPAIRS번). 더해도 대기가 안 줄면 그 사람을 빼고 멈춘다(capacity_limited).
5. 인건비: 노동 쪽 비용 계산(labor.calculate_cost)으로 직원 유급시간 × 시급.

역할: 구간마다 먼저 있던 사람(사장님이 있으면 사장님) 1명이 주문·전달을 먼저 하고 제조를 돕고, 나머지는 제조를 먼저
하고 주문·전달을 돕는다. 혼자면 모든 일을 한다. 근무표는 계획이며 실제 근무 기록이 아니다.
"""

from __future__ import annotations

from datetime import date

from .day_simulation import DayCafe
from .day_window import day, from_scenario, using
from .simulation_common import _scenario, _validate, sample_menu_jobs, summarize
from .simulation_service import _pass, quality_from
from .slot_plan import slot_cohort_pass, slot_pass_rate

UNIT = 30 * 60
LONG_HOURS = 8
MINOR_LONG_HOURS = 7.5  # 연소자 긴 조 상한(휴게 30분 빼면 실제 7시간)
SHORT_HOURS = 4
MIN_STAFF = 1
MAX_STAFF = 6
MAX_FIX_STEPS = 4
MAX_REPAIRS = 4
# 보강 한 번에 이만큼도 안 좋아지면(가장 약한 시간대 대기가 이 초 넘게 안 줄고, 통과한 판도 안 늘면) 사람을 더해도
# 소용없는 것으로 본다(머신이 만들 수 있는 양이 한계인 가게). 그때는 더한 사람을 빼고 멈춘다.
MIN_REPAIR_GAIN_SEC = 5
MAX_ORDER_RUNS = 9000  # 30번이면 하루 300건. 여러 번 돌리므로 compare보다 낮게 둔다.
# 시간대 판정에서 그 시간대 끝 뒤로 이만큼만 손님을 넣는다(그 뒤 손님은 판정에 거의 영향이 없음).
# 하루 전체 확인은 언제나 모든 손님으로 한다.
SLOT_TAIL_SEC = 30 * 60
# 시간대 판정은 그 시간대 시작 1시간 전 손님부터 돌린다. 앞 시간대는 이미 대기 기준(5분 안팎)을 지키게 정했으니
# 1시간보다 앞에서 이어지는 줄은 없다고 본다. 하루 전체 확인(run)은 처음부터 다 돌려서 이 가정을 다시 검사한다.
SLOT_WARMUP_SEC = 60 * 60

LEAD = [["order", "handoff"], ["preparation"]]
MAKER = [["preparation"], ["order", "handoff"]]
SOLO = [["order", "handoff", "preparation"]]


def _groups(position: int, present: int):
    if present == 1:
        return [list(g) for g in SOLO]
    return [list(g) for g in (LEAD if position == 0 else MAKER)]


def _hhmm(sec: int) -> str:
    return day().clock(sec)


# ---------------------------------------------------------------- 엔진 구간표
def _count_rows(counts: list[int]) -> list[dict]:
    """시간대별 인원 → 엔진 구간표(이름 없는 사람 P1..). 1번째 사람이 주문 담당."""
    d = day()
    edges = [d.rel(t) for t in d.edges]
    names = [f"P{i + 1}" for i in range(max(counts))]
    return [
        {
            "start": _hhmm(a),
            "end": _hhmm(b),
            "start_sec": a,
            "end_sec": b,
            "plan_id": "CUSTOM",
            "staff_count": n,
            "assignments": {i: _groups(i, n) for i in range(n)},
            "worker_keys": names,
        }
        for a, b, n in zip(edges, edges[1:], counts)
    ]


def _shift_rows(shifts: list[dict]) -> list[dict]:
    """사람별 근무(휴게 포함) → 엔진 구간표. 휴게 중인 사람은 그 구간에 없다."""
    d = day()
    names = [s["worker_key"] for s in shifts]
    spans = []
    for i, s in enumerate(shifts):
        start, end = d.rel(s["start_time"]), d.rel(s["end_time"])
        rests = sorted((d.rel(b["start_time"]), d.rel(b["end_time"])) for b in s.get("breaks", []))
        cursor = start
        for a, b in rests:
            if a > cursor:
                spans.append((i, cursor, a))
            cursor = max(cursor, b)
        if end > cursor:
            spans.append((i, cursor, end))
    edges = sorted({0, d.length} | {a for _, a, _ in spans} | {b for _, _, b in spans})
    edges = [e for e in edges if 0 <= e <= d.length]
    rows = []
    for lo, hi in zip(edges, edges[1:]):
        present = [i for i, a, b in spans if a <= lo and hi <= b]
        # 주문 담당: 사장님 먼저, 다음은 일찍 출근한 사람
        present.sort(key=lambda i: (not shifts[i].get("is_owner"), shifts[i]["start_time"], i))
        rows.append(
            {
                "start": _hhmm(lo),
                "end": _hhmm(hi),
                "start_sec": lo,
                "end_sec": hi,
                "plan_id": "CUSTOM",
                "staff_count": len(present),
                "assignments": {i: _groups(pos, len(present)) for pos, i in enumerate(present)},
                "worker_keys": names,
            }
        )
    return rows


# ---------------------------------------------------------------- 1. 필요 인원
def _slot_ok(slot_run, rows, index, limit, need):
    """시간대 하나가 기준(30번 중 need 이상 통과)을 지키는지. 결과가 더 바뀔 수 없으면 거기서 멈춘다
    (끝까지 돌린 것과 판정이 같다). (통과 여부, 끝까지 돌렸다면 나올 통과율 또는 None)."""
    passed = checked = 0
    total = slot_run.count
    for k in range(total):
        result = slot_cohort_pass(slot_run(rows, index, k), index, limit)
        if result is not None:
            checked += 1
            passed += int(result)
        left = total - k - 1
        # 남은 판이 모두 실패해도 통과 / 모두 통과해도 실패 → 판정이 정해졌다
        # 조기 판정도 최종 판정과 같이 소수 넷째 자리로 반올림해 비교한다(경계값에서 판정이 갈리지 않게)
        if checked and round(passed / (checked + left), 4) >= need:
            return True, None
        best = max(passed / checked if checked else 0.0, (passed + left) / (checked + left) if checked + left else 0.0)
        if checked + left and round(best, 4) < need:
            return False, None
    if not checked:
        return True, None
    rate = round(passed / checked, 4)
    return rate >= need, rate


def _required(run, slot_run, quality, min_staff, max_staff):
    slots = day().slots
    limit, need = quality["max_p90_post_order_receipt_sec"], quality["min_run_pass_rate"]
    chosen: list[int] = []
    for i in range(len(slots)):
        pick = max_staff
        for n in range(min_staff, max_staff + 1):
            ok, _ = _slot_ok(slot_run, _count_rows(chosen + [n] + [max_staff] * (len(slots) - i - 1)), i, limit, need)
            if ok:
                pick = n
                break
        chosen.append(pick)
    fixes = []
    before = None  # 바로 전에 더한 것: (시간대, 그 전 통과율, 그 전 그 시간대 대기)
    for step in range(MAX_FIX_STEPS + 1):  # 마지막 한 번은 바로 전에 더한 것이 효과가 있었는지 보기만 한다
        records = run(_count_rows(chosen))
        rate = _day_rate(records, limit)
        if before is not None:
            index, old_rate, old_p90 = before
            now_p90 = _slot_p90(records, index)
            gained = rate - old_rate >= 1 / len(records) - 1e-9 or (
                old_p90 is not None and now_p90 is not None and old_p90 - now_p90 >= MIN_REPAIR_GAIN_SEC
            )
            if not gained:
                # 한 명 더해도 대기가 안 줄었다(머신이 한계) → 되돌리고 멈춘다
                chosen[index] -= 1
                fixes.pop()
                break
        if rate >= need or step == MAX_FIX_STEPS:
            break
        weakest = _weakest(records, chosen, limit, max_staff)
        if weakest is None:
            break
        before = (weakest, rate, _slot_p90(records, weakest))
        chosen[weakest] += 1
        fixes.append({"slot": slots[weakest], "to": chosen[weakest], "reason": "하루 전체 기준을 못 지켜 1명 더함"})
    records = run(_count_rows(chosen))
    return chosen, [slot_pass_rate(records, i, limit) for i in range(len(slots))], fixes


def _slot_p90(records, index):
    """시간대 하나의 대기(주문 후 받기 P90, 여러 번 평균). 주문이 적어 못 재면 None."""
    return summarize([r["by_slot"][index]["p90_post_order_receipt_sec"] for r in records])["mean"]


def _day_rate(records, limit) -> float:
    checked = [x for x in (_pass(r, limit) for r in records) if x is not None]
    return sum(checked) / len(checked) if checked else 1.0


def _weakest(records, counts, limit, max_staff):
    """가장 기준에서 먼 시간대(판정 가능한 곳 중 통과율이 가장 낮고, 같으면 대기가 긴 곳). 더 늘릴 수 없으면 None."""
    best = None
    for i in range(len(counts)):
        if counts[i] >= max_staff:
            continue
        rate = slot_pass_rate(records, i, limit)
        p90 = summarize([r["by_slot"][i]["p90_post_order_receipt_sec"] for r in records])["mean"] or 0
        key = (rate if rate is not None else 2.0, -p90)
        if best is None or key < best[0]:
            best = (key, i)
    return None if best is None else best[1]


# ---------------------------------------------------------------- 2. 근무조로 덮기
def _cover(staff_need: list[int], long_units: int, short_units: int) -> list[tuple[int, int, str]]:
    """30분 칸마다 필요한 직원 수를 근무조로 덮는다. (시작 칸, 끝 칸, 종류)."""
    total = len(staff_need)
    have = [0] * total
    shifts = []
    for u in range(total):
        while have[u] < staff_need[u]:
            run = 0
            while u + run < total and staff_need[u + run] > have[u + run]:
                run += 1
            length = max(short_units, min(long_units, run))
            start, end = u, min(total, u + length)
            if end - start < short_units:
                start = max(0, end - short_units)
            for t in range(start, end):
                have[t] += 1
            # 긴 조: 6시간 이상(긴 조 길이가 6시간보다 짧으면 그 길이). 그보다 짧으면 짧은 조.
            long_from = min(long_units, 12)
            shifts.append((start, end, "LONG" if end - start >= long_from else "SHORT"))
    return shifts


def _place_breaks(shifts, need_total, owner_window, peak):
    """직원마다 법정 휴게를 30분 칸에 넣는다. 빠져도 필요 인원이 남는 칸을 먼저 고른다."""
    from app.tools.labor.policies import required_break_seconds

    d = day()
    units = d.length // UNIT
    on = [0] * units
    if owner_window is not None:
        for u in range(owner_window[0] // UNIT, owner_window[1] // UNIT):
            on[u] += 1
    staff = [s for s in shifts if not s["is_owner"]]
    for s in staff:
        for u in range(d.rel(s["start_time"]) // UNIT, d.rel(s["end_time"]) // UNIT):
            on[u] += 1
    peak_units = set(range(d.rel(peak[0]) // UNIT, d.rel(peak[1]) // UNIT))
    out = []
    for s in sorted(shifts, key=lambda x: (x["is_owner"], x["start_time"], x["worker_key"])):
        if s["is_owner"]:
            out.append({**s, "breaks": []})
            continue
        a, b = d.rel(s["start_time"]) // UNIT, d.rel(s["end_time"]) // UNIT
        span = (b - a) * UNIT
        length = next(n for n in (0, 1800, 3600) if n >= required_break_seconds(span - n)) // UNIT
        if length == 0:
            out.append({**s, "breaks": []})
            continue
        # 근무 시작·끝 1시간(짧으면 30분)은 비운다.
        margin = 2 if b - a >= length + 4 else 1
        options = []
        for start in range(a + margin, b - margin - length + 1):
            cells = range(start, start + length)
            short = sum(on[u] - 1 < need_total[u] for u in cells)
            empty = sum(on[u] - 1 <= 0 for u in cells)
            in_peak = sum(u in peak_units for u in cells)
            options.append((short, empty, in_peak, abs(start - (a + b - length) / 2), start))
        if not options:
            out.append({**s, "breaks": []})
            continue
        start = min(options)[-1]
        for u in range(start, start + length):
            on[u] -= 1
        out.append({**s, "breaks": [{"start_time": _hhmm(start * UNIT), "end_time": _hhmm((start + length) * UNIT)}]})
    order = {x["worker_key"]: i for i, x in enumerate(shifts)}
    return sorted(out, key=lambda x: order[x["worker_key"]])


def _units_need(counts, owner_window):
    d = day()
    edges = [d.rel(t) for t in d.edges]
    units = d.length // UNIT
    need = []
    for u in range(units):
        at = u * UNIT
        slot = next(i for i, (a, b) in enumerate(zip(edges, edges[1:])) if a <= at < b)
        owner = owner_window is not None and owner_window[0] <= at < owner_window[1]
        need.append(max(0, counts[slot] - (1 if owner else 0)))
    return need


# ---------------------------------------------------------------- 3·5. 노동 쪽 휴게·인건비
def _labor_body(shifts, wage, business_date, minor):
    workers = [
        {
            "worker_key": s["worker_key"],
            "is_owner": bool(s.get("is_owner")),
            "is_minor": None if s.get("is_owner") else minor,
            "hourly_wage_krw": None if s.get("is_owner") else wage,
        }
        for s in shifts
    ]
    rows = [
        {
            "worker_key": s["worker_key"],
            "start_time": s["start_time"],
            "end_time": s["end_time"],
            "task_code": "ALL_TASKS",
            "breaks": list(s.get("breaks", [])),
        }
        for s in shifts
    ]
    # 노동 계약은 세 안을 받으므로 같은 하루 근무표를 세 칸에 넣고 CURRENT만 읽는다.
    plans = [{"choice_key": k, "shifts": rows} for k in ("CURRENT", "ALT_A", "ALT_C")]
    return {
        "session_id": 1,
        "input_version_id": 1,
        "business_date": business_date.isoformat(),
        "workers": workers,
        "plans": plans,
    }


def _check_breaks(shifts, wage, business_date, minor, peak):
    """넣은 휴게를 노동 쪽 배치표 규칙으로 확인한다. 모자라면 노동 쪽이 더 넣은 휴게를 그대로 쓴다."""
    from app.schemas.labor import ScheduleRequest
    from app.tools.labor.service import create_schedule

    body = _labor_body(shifts, wage, business_date, minor)
    body.update(
        rule_policy_version=f"labor.kr.{business_date.year}.v1",
        auto_break=True,
        avoid_break_windows=[{"start_time": peak[0], "end_time": peak[1]}],
    )
    result = create_schedule(ScheduleRequest.model_validate(body))
    if result.status != "ok":
        raise ValueError(f"NEEDS_INPUT: {result.message}")
    placed = next(p for p in result.data["plans"] if p["choice_key"] == "CURRENT")["schedule"]
    by_key = {row["worker_key"]: row.get("breaks", []) for row in placed}
    return [
        {**s, "breaks": [{"start_time": b["start_time"], "end_time": b["end_time"]} for b in by_key.get(s["worker_key"], [])]}
        for s in shifts
    ]


def _cost(shifts, wage, business_date, minor):
    from app.schemas.labor import CostRequest
    from app.tools.labor.service import calculate_cost

    body = _labor_body(shifts, wage, business_date, minor)
    body.update(wage_year=business_date.year, assumptions_version="operation.daily_roster.v1")
    result = calculate_cost(CostRequest.model_validate(body))
    if result.status != "ok":
        raise ValueError(f"NEEDS_INPUT: {result.message}")
    row = next(p for p in result.data["plans"] if p["choice_key"] == "CURRENT")
    return {
        "employee_paid_hours": round(row["employee_paid_seconds"] / 3600, 2),
        "cash_cost_krw": row["cash_cost_krw"],
        "basis": "직원 유급시간 × 시급(휴게 무급, 주휴·보험 제외). 사장님 근무는 빼요.",
    }


# ---------------------------------------------------------------- 하루 근무표
def _rules(body, minor=False):
    raw = body.get("roster_rules") or {}
    if not isinstance(raw, dict):
        raise ValueError("roster_rules는 객체여야 해요.")
    long_h = raw.get("long_shift_hours", LONG_HOURS)
    short_h = raw.get("short_shift_hours", SHORT_HOURS)
    min_s = raw.get("min_staff", MIN_STAFF)
    max_s = raw.get("max_staff", MAX_STAFF)
    for v, lo, hi, name in ((long_h, 4, 10, "긴 조"), (short_h, 2, 8, "짧은 조")):
        if type(v) not in (int, float) or not lo <= v <= hi or (v * 2) != int(v * 2):
            raise ValueError(f"{name} 길이는 {lo}~{hi}시간, 30분 단위예요.")
    if minor:
        # 연소자는 하루 실제 근무 7시간까지: 7시간 30분 머무르고 30분 쉬면 7시간이다. 입력을 검사한 뒤에 줄인다.
        long_h = min(long_h, MINOR_LONG_HOURS)
    if short_h > long_h:
        raise ValueError("짧은 조가 긴 조보다 길 수 없어요.")
    if type(min_s) is not int or type(max_s) is not int or not 1 <= min_s <= max_s <= 8:
        raise ValueError("시간대 인원은 1~8명 사이예요.")
    return {"long_shift_hours": long_h, "short_shift_hours": short_h, "min_staff": min_s, "max_staff": max_s}


def _owner(body):
    owner = body.get("owner") or {}
    if not isinstance(owner, dict):
        raise ValueError("owner는 객체여야 해요.")
    if not owner.get("is_working"):
        return None
    d = day()
    start = owner.get("start_time") or d.open
    end = owner.get("end_time") or d.close
    a, b = d.rel(start), d.rel(end)
    if not 0 <= a < b <= d.length or a % UNIT or b % UNIT:
        raise ValueError("사장님 근무시간은 영업시간 안에서 30분 단위로 골라 주세요.")
    return (a, b)


def plan(body: dict, engine: str = "simpy", include_curve: bool = False) -> dict:
    """include_curve: 하루 내내 n명일 때 대기 표(staff_curve)도 만든다. 화면은 추천 근무표의 "바쁜 시간에 더하기"를 써서
    기본은 끈다(바쁜 날은 계산이 길어진다)."""
    spec = body.get("scenario") if isinstance(body, dict) else None
    with using(from_scenario(spec)):
        return _plan(body, engine, include_curve)


def _rows_key(rows):
    return tuple(
        (r["start_sec"], r["end_sec"], tuple(sorted((i, str(g)) for i, g in r["assignments"].items())))
        for r in rows
    )


def _curve(run, min_staff, max_staff, limit):
    """인원을 하루 내내 n명(서로 돕기)으로 두었을 때 시간대별 대기. "1명 더 쓰면" 비교용.
    시간대마다 따로 찾는 필요 인원과 달리 모든 시간대가 같은 인원이라, 어림 비교로만 쓴다."""
    slots = day().slots
    out = []
    for n in range(min_staff, max_staff + 1):
        records = run(_count_rows([n] * len(slots)))
        out.append(
            {
                "staff": n,
                "day_p90_sec": summarize([r["p90_post_order_receipt_sec"] for r in records])["mean"],
                "day_pass_rate": round(_day_rate(records, limit), 4),
                "by_slot": [
                    {
                        "slot": slot,
                        "p90_sec": summarize([r["by_slot"][i]["p90_post_order_receipt_sec"] for r in records])["mean"],
                        "pass_rate": slot_pass_rate(records, i, limit),
                    }
                    for i, slot in enumerate(slots)
                ],
            }
        )
    return out


def _prepare(body, engine, include_curve=False):
    """손님 조건을 읽고 시간대별 필요 인원을 찾는다(근무조 규칙과 상관없음). 근무조 만들기는 _build."""
    quality = quality_from(body)
    repetitions, seed, conf = _validate(body)
    scn = _scenario(body.get("scenario", {"daily_orders": 100}))
    if scn["planned_orders_before_last_order_filter"] < 1:
        raise ValueError("NEEDS_INPUT: 하루 주문이 0건이면 근무표를 만들 수 없어요.")
    if scn["planned_orders_before_last_order_filter"] * repetitions > MAX_ORDER_RUNS:
        raise ValueError(
            f"NEEDS_INPUT: 근무표 계산은 하루 {MAX_ORDER_RUNS // repetitions}건까지 해요(반복 {repetitions}번)."
        )
    minor = bool(body.get("is_staff_minor", False))
    rules = _rules(body, minor)
    owner_window = _owner(body)
    wage = body.get("hourly_wage_krw")
    if type(wage) not in (int, float) or wage <= 0:
        raise ValueError("NEEDS_INPUT: 직원 시급이 필요해요.")
    business_date = date.fromisoformat(body["business_date"]) if body.get("business_date") else date.today()
    d = day()

    draws = [sample_menu_jobs(scn, seed + r, conf) for r in range(repetitions)]
    cache: dict = {}

    def run(rows):
        key = _rows_key(rows)
        if key not in cache:
            # 근무표 찾기는 대기 판정 값만 읽으므로 가벼운 요약(lite)으로 돌린다(값은 전체 요약과 같다).
            cache[key] = [DayCafe(orders, rows, conf, "DAILY_ROSTER", engine, lite=True).simulate() for orders, _ in draws]
        return cache[key]

    limit, need_rate = quality["max_p90_post_order_receipt_sec"], quality["min_run_pass_rate"]
    slot_ends = [d.rel(t.split("-")[1]) for t in d.slots]
    slot_starts = [d.rel(t.split("-")[0]) for t in d.slots]
    slot_cache: dict = {}

    def slot_run(rows, index, k):
        """k번째 판을 시간대 index 판정용으로 돌린다(그 시간대 시작 1시간 전 ~ 끝 + SLOT_TAIL_SEC 손님만)."""
        key = (_rows_key(rows), index, k)
        if key not in slot_cache:
            cut = slot_ends[index] + SLOT_TAIL_SEC
            begin = slot_starts[index] - SLOT_WARMUP_SEC
            orders = [o for o in draws[k][0] if begin <= o["arrival_sec"] < cut]
            slot_cache[key] = DayCafe(orders, rows, conf, "DAILY_ROSTER", engine, lite=True).simulate()
        return slot_cache[key]

    slot_run.count = repetitions
    counts, rates, fixes = _required(run, slot_run, quality, rules["min_staff"], rules["max_staff"])
    curve = _curve(run, rules["min_staff"], rules["max_staff"], limit) if include_curve else None
    return {
        "curve": curve,
        "quality": quality, "repetitions": repetitions, "scn": scn, "rules": rules, "minor": minor,
        "owner_window": owner_window, "wage": wage, "business_date": business_date, "run": run,
        "counts": counts, "rates": rates, "fixes": fixes, "limit": limit, "need_rate": need_rate,
    }


def _build(ctx, rules):
    """찾은 필요 인원을 근무조 규칙(rules)으로 덮고, 휴게·확인·보강·인건비까지 한다."""
    d = day()
    quality, repetitions, scn = ctx["quality"], ctx["repetitions"], ctx["scn"]
    minor, owner_window, wage, business_date = ctx["minor"], ctx["owner_window"], ctx["wage"], ctx["business_date"]
    run, counts, rates, fixes = ctx["run"], ctx["counts"], ctx["rates"], ctx["fixes"]
    limit, need_rate = ctx["limit"], ctx["need_rate"]
    staff_need = _units_need(counts, owner_window)
    units = _cover(staff_need, int(rules["long_shift_hours"] * 2), int(rules["short_shift_hours"] * 2))

    shifts = []
    if owner_window is not None:
        shifts.append(
            {"worker_key": "OWNER", "is_owner": True, "kind": "OWNER",
             "start_time": _hhmm(owner_window[0]), "end_time": _hhmm(owner_window[1]), "breaks": []}
        )
    for n, (a, b, kind) in enumerate(units, start=1):
        shifts.append(
            {"worker_key": f"STAFF_{n}", "is_owner": False, "kind": kind,
             "start_time": _hhmm(a * UNIT), "end_time": _hhmm(b * UNIT), "breaks": []}
        )
    if not shifts:
        raise ValueError("NEEDS_INPUT: 일할 사람이 없어요.")

    repairs = []
    short_units = int(rules["short_shift_hours"] * 2)
    total_units = d.length // UNIT
    need_total = []
    edges = [d.rel(t) for t in d.edges]
    for u in range(total_units):
        at = u * UNIT
        need_total.append(counts[next(i for i, (x, y) in enumerate(zip(edges, edges[1:])) if x <= at < y)])
    capacity_limited = None  # 사람을 더해도 대기가 안 줄던 시간대
    before = None  # 바로 전 보강 전 상태: (근무조, 통과율, 약한 시간대, 그 대기)
    for attempt in range(MAX_REPAIRS + 1):
        shifts = _place_breaks(shifts, need_total, owner_window, d.peak)
        shifts = _check_breaks(shifts, wage, business_date, minor, d.peak)
        records = run(_shift_rows(shifts))
        day_rate = _day_rate(records, limit)
        if before is not None:
            old_shifts, old_rate, old_slot, old_p90 = before
            now_p90 = _slot_p90(records, old_slot)
            gained = day_rate - old_rate >= 1 / len(records) - 1e-9 or (
                old_p90 is not None and now_p90 is not None and old_p90 - now_p90 >= MIN_REPAIR_GAIN_SEC
            )
            if not gained:
                # 더한 사람이 대기를 줄이지 못했다 → 그 사람을 빼고 멈춘다(더 더해도 인건비만 는다).
                shifts = old_shifts
                repairs.pop()
                capacity_limited = {"slot": d.slots[old_slot], "p90_sec": old_p90}
                break
        if day_rate >= need_rate or attempt == MAX_REPAIRS:
            break
        weakest = _weakest_slot(records, limit)
        before = (list(shifts), day_rate, weakest, _slot_p90(records, weakest))  # 아래 append가 바꾸지 않게 복사
        slot = d.slots[weakest]
        a = d.rel(slot.split("-")[0]) // UNIT
        b = min(total_units, a + short_units)
        a = max(0, b - short_units)
        key = f"STAFF_{sum(1 for s in shifts if not s['is_owner']) + 1}"
        shifts.append(
            {"worker_key": key, "is_owner": False, "kind": "SHORT",
             "start_time": _hhmm(a * UNIT), "end_time": _hhmm(b * UNIT), "breaks": []}
        )
        repairs.append({"slot": slot, "added": key, "reason": "휴게까지 넣고 다시 돌렸을 때 기준을 못 지켜 짧은 조를 더함"})
        shifts = [{**s, "breaks": []} for s in shifts]  # 사람이 늘었으니 휴게를 다시 넣는다

    # Only roster-options supplies this hook; standalone daily planning is unchanged.
    refine = ctx.get("break_refine")
    if refine is not None:
        shifts = refine(shifts, ctx, need_total)
    rows = _shift_rows(shifts)
    records = run(rows)
    slots = d.slots
    present_by_slot = []
    for i, slot in enumerate(slots):
        a, b = (d.rel(t) for t in slot.split("-"))
        inside = [r["staff_count"] for r in rows if r["start_sec"] < b and r["end_sec"] > a]
        present_by_slot.append({"min": min(inside), "max": max(inside)})
    p90 = summarize([r["p90_post_order_receipt_sec"] for r in records])["mean"]
    cost = _cost(shifts, wage, business_date, minor)
    return {
        "model_version": "operation.daily_roster.v1",
        "scenario": {k: scn[k] for k in ("start", "end", "last_order_time", "orders_by_slot", "peak_start_time", "peak_end_time")},
        "repetitions": repetitions,
        "quality_targets": quality,
        "rules": rules,
        "required_by_slot": [
            {
                "slot": slot,
                "orders": scn["orders_by_slot"][slot],
                "required_staff": counts[i],
                "owner_present": owner_window is not None
                and owner_window[0] < d.rel(slot.split("-")[1])
                and owner_window[1] > d.rel(slot.split("-")[0]),
                "pass_rate": rates[i],
                "on_roster_min": present_by_slot[i]["min"],
                "on_roster_max": present_by_slot[i]["max"],
            }
            for i, slot in enumerate(slots)
        ],
        "required_fixes": fixes,
        "staff_curve": ctx["curve"],
        # 휴게까지 넣은 근무표로 돌린 시간대별 대기(주문 후 받기 P90, 반복 평균). 주문이 적은 시간대는 null.
        "slot_p90_sec": [
            summarize([r["by_slot"][i]["p90_post_order_receipt_sec"] for r in records])["mean"] for i in range(len(slots))
        ],
        "shifts": [
            {
                **s,
                "span_hours": (d.rel(s["end_time"]) - d.rel(s["start_time"])) / 3600,
                "break_minutes": sum((d.rel(b["end_time"]) - d.rel(b["start_time"])) // 60 for b in s["breaks"]),
            }
            for s in shifts
        ],
        "coverage": [
            {"start_time": r["start"], "end_time": r["end"], "on_duty": r["staff_count"]} for r in rows
        ],
        # 혼자 일하는 사람이 쉬는 동안처럼 매장이 비는 때. 계산은 통과해도 사장님이 알아야 한다.
        "empty_periods": [
            {"start_time": r["start"], "end_time": r["end"]} for r in rows if r["staff_count"] == 0
        ],
        "verification": {
            "with_breaks": True,
            "pass_rate": round(_day_rate(records, limit), 4),
            "passes": _day_rate(records, limit) >= need_rate,
            "p90_post_order_receipt_sec": p90,
            "repairs": repairs,
            # 사람을 더해도 대기가 안 줄어 보강을 멈춘 시간대(없으면 None). 화면이 "머신이 한계" 안내에 쓴다.
            "capacity_limited": capacity_limited,
        },
        "cost": cost,
        "assumptions": [
            f"시간대별 필요 인원은 같은 손님 조건 {repetitions}번으로 대기 기준을 지키는 가장 적은 인원이에요(앞 시간대부터 차례로 찾음).",
            f"근무조는 이어서 필요한 시간만큼 {rules['short_shift_hours']:g}~{rules['long_shift_hours']:g}시간, 30분 단위예요.",
            "휴게는 노동 규칙(4시간 이상 30분, 8시간 이상 1시간) 길이로, 빠져도 필요 인원이 남는 때를 먼저 골랐어요(다음으로 매장이 비지 않는 때, 바쁜 시간 밖).",
            "휴게로 빠지는 사람까지 넣어 다시 돌려 확인했어요.",
            "구간마다 먼저 온 1명이 주문·전달을 먼저 하고, 나머지는 제조를 먼저 해요(서로 도움).",
            "계획 근무표이며 실제 근무 기록이 아니에요. 주휴·보험·가산수당은 빼고 계산했어요.",
        ],
    }



def _plan(body, engine, include_curve=False):
    ctx = _prepare(body, engine, include_curve=include_curve)
    return _build(ctx, ctx["rules"])


def plan_variants(body: dict, variants: dict, engine: str = "simpy") -> dict:
    """필요 인원은 한 번만 찾고, 근무조 규칙만 바꿔 여러 근무표를 만든다. {이름: 근무표}."""
    spec = body.get("scenario") if isinstance(body, dict) else None
    with using(from_scenario(spec)):
        ctx = _prepare(body, engine)
        out = {}
        for name, raw in variants.items():
            rules = _rules({**body, "roster_rules": {**(body.get("roster_rules") or {}), **raw}}, ctx["minor"])
            out[name] = _build(ctx, rules)
        return out

def _weakest_slot(records, limit):
    slots = day().slots
    best = None
    for i in range(len(slots)):
        rate = slot_pass_rate(records, i, limit)
        p90 = summarize([r["by_slot"][i]["p90_post_order_receipt_sec"] for r in records])["mean"] or 0
        key = (rate if rate is not None else 2.0, -p90)
        if best is None or key < best[0]:
            best = (key, i)
    return best[1]

