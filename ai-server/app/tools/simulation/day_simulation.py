"""카페 하루 시뮬레이션(오픈~마감, 기본 07:00~19:00, 라스트 오더는 마감 전).

라스트 오더 뒤에는 새 손님을 받지 않는다. 이미 받은 주문은 대기 시간을 재려고 끝까지 만들고,
마지막 근무표의 직원이 끝낸다. 마감 뒤로 얼마나 넘겼는지는 참고로만 알린다.
합격 기준이 아니고 직원 근무시간에도 더하지 않는다. 급여 계산기가 아니다.
"""

from __future__ import annotations
import math
import statistics

from .engine import SlotCafe
from .day_window import day

# 기본 영업시간(07~19시)의 길이. 계산 중에는 day().length를 쓴다.
def seconds(hhmm_text):
    """시각 → 오픈부터 지난 초(지금 계산의 영업시간 기준)."""
    return day().rel(hhmm_text)


def percentile(values, q=0.90):
    if not values:
        return None
    xs = sorted(values)
    point = (len(xs) - 1) * q
    lo, hi = math.floor(point), math.ceil(point)
    return round(xs[lo] + (xs[hi] - xs[lo]) * (point - lo), 3)


def served_by(values, share=0.90):
    """손님 중 `share` 비율 이상이 음료를 받은 시각(가장 가까운 순위, 보간 없음).

    `served_by(waits) <= limit`가 곧 "손님 share 비율이 limit 안에 받음"이라 합격 판정은 이걸 쓴다.
    보간하는 percentile()은 화면 표시용으로만 남긴다.
    """
    if not values:
        return None
    xs = sorted(values)
    need = max(1, math.ceil(len(xs) * share - 1e-9))
    return round(xs[need - 1], 3)


def profile(plan_id):
    if plan_id == "CURRENT":
        return [[["order", "handoff"]], [["preparation"]]]
    if plan_id == "ALT_A":
        return [
            [["order", "handoff"], ["preparation"]],
            [["preparation"], ["order", "handoff"]],
        ]
    if plan_id == "ALT_C":
        return [
            [["order", "handoff"]],
            [["preparation"]],
            [["preparation"], ["order", "handoff"]],
        ]
    raise ValueError("Unknown roster profile")


def peak_edges():
    """바쁜 시간 앞·바쁜 시간·뒤 경계(길이 0인 구간은 뺀다). 기본은 07·11·14·19시."""
    d = day()
    return list(dict.fromkeys([d.open, d.peak[0], d.peak[1], d.close]))


def roster(mode, plan_ids):
    # 근무표 하나가 영업시간 전체를 덮는다. "three": 바쁜 시간 전 / 바쁜 시간 / 바쁜 시간 뒤.
    # "four": 손님 시간대마다 한 구간(기본 4개, 가게 데이터면 시간대 수만큼).
    edges = peak_edges() if mode == "three" else list(day().edges)
    if mode not in ("three", "four") or len(plan_ids) != len(edges) - 1:
        raise ValueError("roster mode and plan count mismatch")
    return [
        {
            "start": edges[i],
            "end": edges[i + 1],
            "start_sec": seconds(edges[i]),
            "end_sec": seconds(edges[i + 1]),
            "plan_id": pid,
            "staff_count": len(profile(pid)),
        }
        for i, pid in enumerate(plan_ids)
    ]


# Spring 근무표의 업무 코드 → 엔진 역할 묶음(앞 묶음을 먼저 맡고, 뒤 묶음은 도울 수 있는 일).
TASK_GROUPS = {
    "ALL_TASKS": [["order", "handoff", "preparation"]],
    "ORDER_HANDOFF": [["order", "handoff"]],
    "PREPARATION": [["preparation"]],
    "ORDER_HANDOFF_HELP_PREPARATION": [["order", "handoff"], ["preparation"]],
    "PREPARATION_HELP_ORDER_HANDOFF": [["preparation"], ["order", "handoff"]],
    "ORDER": [["order", "handoff"]],
    "MAKE": [["preparation"]],
    "FLEX": [["order", "handoff", "preparation"]],
}
ROLE_GROUPS = {
    "ORDER": ["order", "handoff"],
    "MAKE": ["preparation"],
    "FLEX": ["order", "handoff", "preparation"],
}


def shift_groups(shift):
    """한 근무 구간의 역할 묶음. 기존 업무 코드와 직원별 역할(primary_role·can_support)을 모두 받는다."""
    role = shift.get("primary_role")
    if role is not None:
        if role not in ROLE_GROUPS:
            raise ValueError(f"알 수 없는 역할입니다: {role}")
        groups = [list(ROLE_GROUPS[role])]
        for extra in shift.get("can_support") or []:
            if extra not in ("ORDER", "MAKE") or extra == role:
                raise ValueError(f"지원 업무가 올바르지 않습니다: {extra}")
            groups.append(list(ROLE_GROUPS[extra]))
        return groups
    code = shift.get("task_code")
    if code not in TASK_GROUPS:
        raise ValueError(f"시뮬레이션에서 쓸 수 없는 업무 코드입니다: {code}")
    return [list(g) for g in TASK_GROUPS[code]]


def roster_from_shifts(shifts):
    """직원별 근무 구간 → 하루(오픈~마감) 구간표. 휴게는 반영하지 않는다(labor 배치표에서만 다룸).

    구간마다 그 시간에 일하는 직원(번호)과 역할 묶음을 담는다. 직원 번호는 근무표에 처음 나온 순서다.
    """
    if not shifts:
        raise ValueError("근무 구간이 비어 있습니다.")
    keys = []
    spans = []
    for shift in shifts:
        key = shift.get("worker_key")
        if not isinstance(key, str) or not key:
            raise ValueError("worker_key가 필요합니다.")
        start, end = seconds(shift["start_time"]), seconds(shift["end_time"])
        if start >= end:
            raise ValueError(f"{key} 근무의 시작이 끝보다 빨라야 합니다.")
        start, end = max(start, 0), min(end, day().length)
        if start >= end:
            continue  # 영업시간 밖 근무는 손님 흐름에 영향이 없다.
        if key not in keys:
            keys.append(key)
        spans.append((keys.index(key), start, end, shift_groups(shift)))
    if not spans:
        raise ValueError(f"{day().label.replace('-', '~')} 안에 일하는 사람이 없습니다.")
    edges = sorted(
        {0, day().length} | {s for _, s, _, _ in spans} | {e for _, _, e, _ in spans}
    )
    rows = []
    for lo, hi in zip(edges, edges[1:]):
        assignments = {}
        for idx, start, end, groups in spans:
            if start <= lo and hi <= end:
                if idx in assignments:
                    raise ValueError(f"{keys[idx]}의 근무 구간이 겹칩니다.")
                assignments[idx] = groups
        rows.append(
            {
                "start": _clock(lo),
                "end": _clock(hi),
                "start_sec": lo,
                "end_sec": hi,
                "plan_id": "CUSTOM",
                "staff_count": len(assignments),
                "assignments": assignments,
                "worker_keys": keys,
            }
        )
    if not rows[-1]["assignments"]:
        raise ValueError(
            f"NEEDS_INPUT: {day().close} 마감까지 일하는 사람이 있어야 받은 주문을 끝낼 수 있어요. 근무표를 확인해 주세요."
        )
    return rows


def _clock(sec):
    return day().clock(sec)


def roster_for_base(pid):
    """세 안 비교용 하루 근무표(11.11 팀 결정): A·C안은 11~14시에만 적용하고
    나머지 시간은 CURRENT로 돈다. 나머지 시간은 시간대별 추천이 맡는다."""
    edges = peak_edges()
    peak_start = day().peak[0]
    return roster(
        "three",
        [pid if a == peak_start else "CURRENT" for a in edges[:-1]],
    )


class DayCafe(SlotCafe):
    def __init__(
        self,
        orders,
        roster_segments,
        config,
        label,
        clock_mode="simpy",
        include_events=False,
        lite=False,
    ):
        # lite: 근무표 찾기용 가벼운 요약(대기 판정에 쓰는 숫자만). 숫자는 전체 요약과 같다.
        self.lite = lite
        self.roster_segments = roster_segments
        # 구간마다 {직원 번호: 역할 묶음}. 정해 둔 세 운영안은 profile에서, 받은 근무표는 roster_from_shifts에서 온다.
        self.assignments = [
            row["assignments"]
            if "assignments" in row
            else dict(enumerate(profile(row["plan_id"])))
            for row in roster_segments
        ]
        names = next(
            (row["worker_keys"] for row in roster_segments if row.get("worker_keys")),
            None,
        )
        count = max(
            [len(names) if names else 0] + [max(a) + 1 for a in self.assignments if a]
        )
        all_workers = [
            {
                "id": names[i] if names else f"EMP_{i + 1:02d}",
                "priority_groups": [["order", "preparation", "handoff"]],
            }
            for i in range(count)
        ]
        self.day = day()
        self.day_end = self.day.length
        super().__init__(
            orders,
            {"id": label, "employees": all_workers},
            config,
            (self.day.label, 0, self.day_end),
            clock_mode,
            include_events,
        )
        self.active_work_sec = {w["id"]: 0.0 for w in self.workers}
        self.worker_index = {w["id"]: i for i, w in enumerate(self.workers)}

    def _segment_index(self, at=None):
        if at is None:
            # 같은 시각에 여러 번 묻는다(직원·작업마다). 근무 구간은 바뀌지 않으니 시각별로 한 번만 찾는다.
            now = self.clock.now
            cached = getattr(self, "_segment_at", None)
            if cached is not None and cached[0] == now:
                return cached[1]
            index = self._find_segment(now)
            self._segment_at = (now, index)
            return index
        return self._find_segment(at)

    def _find_segment(self, at):
        if at >= self.day_end:
            # 마지막까지 있는 직원이 이미 받은 주문을 끝낸다.
            return len(self.roster_segments) - 1
        return next(
            (
                i
                for i, r in enumerate(self.roster_segments)
                if r["start_sec"] <= at < r["end_sec"]
            ),
            None,
        )

    def _segment(self, at=None):
        i = self._segment_index(at)
        return None if i is None else self.roster_segments[i]

    def _index(self, worker):
        return self.worker_index[worker["id"]]

    def _employee_window_end(self, worker):
        """이 직원이 계속 있는 구간이 끝나는 시각."""
        idx = self._index(worker)
        at = self.clock.now
        end = at
        for row, present in zip(self.roster_segments, self.assignments):
            if row["end_sec"] <= at + 1e-8:
                continue
            if row["start_sec"] > end + 1e-7:
                break
            if idx not in present:
                break
            end = row["end_sec"]
        # 마감 시각에 있던 직원은 받은 주문을 마감 뒤에도 끝낼 수 있다.
        if end >= self.day_end and idx in self.assignments[-1]:
            return math.inf
        return end

    def _worker_can_start(self, worker, task):
        if not task["needs_worker"]:
            return False
        groups = self._worker_groups(worker)
        if not groups:
            return False
        if self.clock.now + task["seconds"] > self._employee_window_end(worker) + 1e-8:
            return False
        if (
            task["equipment"] is not None
            and self.equipment_busy[task["equipment"]]
            >= self.equipment_counts[task["equipment"]]
        ):
            return False
        return True

    def _worker_groups(self, worker):
        i = self._segment_index()
        if i is None:
            return []
        return self.assignments[i].get(self._index(worker), [])

    def _pick_task(self, worker):
        """역할 묶음 순서대로, 지금 시작할 수 있는 작업 중 가장 먼저 들어온 것.

        _worker_can_start와 같은 조건을 작업마다 다시 계산하지 않게 한 번만 구한다(같은 시각·같은 직원이라 값이 같다).
        - 줄(queue)은 들어온 순번(seq) 순이라 처음 맞는 작업이 min(seq)와 같다(줄 끝에만 넣고, 빼도 순서는 그대로).
        - 직원이 계속 있는 시간 끝(_employee_window_end)은 맞는 작업이 있을 때 처음 한 번만 구한다.
        """
        groups = self._worker_groups(worker)
        if not groups:
            return None
        now = self.clock.now
        busy, counts = self.equipment_busy, self.equipment_counts
        window_end = None
        for group in groups:
            for t in self.queue:
                if t["stage"] not in group or not t["needs_worker"]:
                    continue
                if window_end is None:
                    window_end = self._employee_window_end(worker)
                if now + t["seconds"] > window_end + 1e-8:
                    continue
                eq = t["equipment"]
                if eq is not None and busy[eq] >= counts[eq]:
                    continue
                return t
        return None

    def _slot_summary(self):
        jobs = list(self.jobs.values())
        byslot = []
        # 시간대와 상관없는 것은 한 번만 만든다(예전에는 시간대마다 모든 작업을 다시 훑었다).
        # 머신·직원별 (시작, 끝) 목록은 작업 순서 그대로 둔다: 더하는 순서가 같아야 반올림 전 합계가 똑같다.
        done = [j for j in jobs if j.get("completed_at_sec") is not None]
        by_equipment = {name: [] for name in self.equipment_counts}
        by_worker = {w["id"]: [] for w in self.workers}
        for j in jobs:
            for t in j["tasks"]:
                start = t["started_at"]
                if start is None:
                    continue  # 시작 안 한 작업은 0초라 합계에 영향이 없다
                end = t["ended_at"] if t["ended_at"] is not None else start + t["seconds"]
                if t["equipment"] in by_equipment:
                    by_equipment[t["equipment"]].append((start, end))
                if t.get("assigned_worker") in by_worker:
                    by_worker[t["assigned_worker"]].append((start, end))
        bounds = [tuple(map(seconds, label.split("-"))) for label in self.day.slots]

        def busy_by_slot(intervals):
            # 작업 하나가 겹치는 시간대는 보통 1~2개라, 작업마다 겹치는 시간대에만 더한다(작업 순서대로 더해 합계가 예전과 같다).
            totals = [0] * len(bounds)
            for start, end in intervals:
                for i, (lo, hi) in enumerate(bounds):
                    if lo >= end:
                        break  # 시간대는 앞에서부터 차례라 이후는 안 겹친다
                    if hi > start:
                        totals[i] += max(0.0, min(end, hi) - max(start, lo))
            return totals

        equipment_busy = {name: busy_by_slot(v) for name, v in by_equipment.items()}
        worker_busy = {wid: busy_by_slot(v) for wid, v in by_worker.items()}
        for slot_no, label in enumerate(self.day.slots):
            lo, hi = bounds[slot_no]
            arrived = [j for j in jobs if lo <= j["arrival_sec"] < hi]
            completion = [j for j in done if lo < j["completed_at_sec"] <= hi]
            backlog_start = sum(
                j["arrival_sec"] < lo
                and (j.get("completed_at_sec") is None or j["completed_at_sec"] > lo)
                for j in jobs
            )
            backlog_end = sum(
                j["arrival_sec"] < hi
                and (j.get("completed_at_sec") is None or j["completed_at_sec"] > hi)
                for j in jobs
            )
            cohort_done = [j for j in arrived if j.get("completed_at_sec") is not None]
            cohort_done_by_close = [
                j for j in cohort_done if j["completed_at_sec"] <= self.day_end
            ]
            waits = [j["queue_wait_sec"] for j in cohort_done]
            post_order_waits = [
                j["completed_at_sec"]
                - next(t["ended_at"] for t in j["tasks"] if t["stage"] == "order")
                for j in cohort_done
            ]
            equipment_util = {
                name: round(equipment_busy[name][slot_no] / ((hi - lo) * count), 4)
                for name, count in self.equipment_counts.items()
            }
            staff_util = {w["id"]: round(worker_busy[w["id"]][slot_no] / (hi - lo), 4) for w in self.workers}
            byslot.append(
                {
                    "slot": label,
                    "arrived_in_slot": len(arrived),
                    "completed_in_slot": len(completion),
                    "backlog_at_start": backlog_start,
                    "backlog_at_end": backlog_end,
                    "carried_from_previous_slot": backlog_start,
                    "carried_to_next_slot": backlog_end if hi < self.day_end else 0,
                    "unfinished_at_close": backlog_end if hi == self.day_end else None,
                    "cohort_completed_by_slot_end": sum(
                        j["completed_at_sec"] <= hi for j in cohort_done
                    ),
                    "cohort_completion_ratio_by_slot_end": round(
                        sum(j["completed_at_sec"] <= hi for j in cohort_done)
                        / len(arrived),
                        4,
                    )
                    if arrived
                    else 1.0,
                    "cohort_completed_by_close": len(cohort_done_by_close),
                    "cohort_completed_eventually": len(cohort_done),
                    "avg_queue_wait_sec": round(statistics.mean(waits), 3)
                    if waits
                    else None,
                    "p90_queue_wait_sec": percentile(waits),
                    "avg_post_order_receipt_sec": round(
                        statistics.mean(post_order_waits), 3
                    )
                    if post_order_waits
                    else None,
                    "p90_post_order_receipt_sec": percentile(post_order_waits),
                    "served90_post_order_receipt_sec": served_by(post_order_waits),
                    "equipment_utilization": equipment_util,
                    "employee_utilization": staff_util,
                }
            )
            assert backlog_end == backlog_start + len(arrived) - len(completion)
        return byslot

    def _lite_summary(self, jobs):
        """근무표 찾기(daily_roster·roster_options)가 읽는 값만 만든다.

        하루: 들어온·끝난 손님 수, 주문 후 받기 P90·10명 중 9명. 시간대마다: 그 시간대 손님 수와 같은 두 값.
        계산식은 전체 요약(simulate 아래·_slot_summary)과 같아서 값이 똑같다(테스트가 비교한다).
        머신·직원 사용률, 평균, 단계별 대기, 메뉴 수처럼 근무표 찾기가 안 읽는 값은 만들지 않는다.
        """
        post = {}
        for j in jobs:
            order_end = next(t["ended_at"] for t in j["tasks"] if t["stage"] == "order")
            post[id(j)] = j["completed_at_sec"] - order_end
        finished = sorted(self.finished, key=lambda j: j["completed_at_sec"])
        day_post = [post[id(j)] for j in finished]
        by_slot = []
        for label in self.day.slots:
            lo, hi = map(seconds, label.split("-"))
            waits = [post[id(j)] for j in jobs if lo <= j["arrival_sec"] < hi]
            by_slot.append(
                {
                    "cohort_completed_eventually": len(waits),
                    "p90_post_order_receipt_sec": percentile(waits),
                    "served90_post_order_receipt_sec": served_by(waits),
                }
            )
        return {
            "arrived_orders": len(jobs),
            "completed_eventually": len(finished),
            "p90_post_order_receipt_sec": percentile(day_post),
            "served90_post_order_receipt_sec": served_by(day_post),
            "by_slot": by_slot,
        }

    def simulate(self):
        # 시간대별 바쁨 비율을 내려고 일마다 맡은 자원을 기록한다.
        for boundary in sorted({r["start_sec"] for r in self.roster_segments[1:]}):
            self.clock.schedule(boundary, self.dispatch)
        for order in self.orders:
            self.clock.schedule(order["arrival_sec"], lambda o=order: self.arrival(o))
        # 마감 때 남은 주문은 마지막 근무표가 처리한다.
        # 가상 시간 끝을 지키고, 대기열이 비지 않으면 분명하게 실패로 알린다.
        horizon = self.day_end + 3600 * max(4, len(self.orders) + 1)
        self.clock.run(horizon)
        finished = sorted(self.finished, key=lambda j: j["completed_at_sec"])
        all_jobs = list(self.jobs.values())
        assert len(all_jobs) == len(self.orders)
        if len(finished) != len(self.orders):
            raise RuntimeError(
                f"Accepted orders did not finish: {len(finished)}/{len(self.orders)}"
            )
        if self.lite:
            return self._lite_summary(all_jobs)
        finished_by_close = [
            j for j in finished if j["completed_at_sec"] <= self.day_end + 1e-7
        ]
        waits = [j["queue_wait_sec"] for j in finished]
        elapsed = [j["elapsed_sec"] for j in finished]
        post_order_waits = [
            j["completed_at_sec"]
            - next(t["ended_at"] for t in j["tasks"] if t["stage"] == "order")
            for j in finished
        ]
        drain_sec = max(
            0.0,
            max((j["completed_at_sec"] for j in finished), default=self.day_end)
            - self.day_end,
        )
        stage_wait = {
            key: (
                round(statistics.mean([j["wait_sec"][key] for j in finished]), 3)
                if finished
                else None
            )
            for key in ("order", "preparation", "handoff")
        }
        stages = stage_wait
        bottleneck = (
            max(stages, key=lambda k: stages[k] or 0.0)
            if any(x for x in stages.values())
            else None
        )
        from collections import Counter

        menu_counts = Counter(j["menu_id"] for j in all_jobs)
        staff_hours = (
            sum(
                (r["end_sec"] - r["start_sec"]) * r["staff_count"]
                for r in self.roster_segments
            )
            / 3600
        )
        changes = sum(
            a["staff_count"] != b["staff_count"]
            for a, b in zip(self.roster_segments, self.roster_segments[1:])
        )
        tasks = [t for j in all_jobs for t in j["tasks"]]
        for t in tasks:
            if t.get("assigned_worker"):
                assert t["started_at"] is not None
        return {
            "slot": self.day.label,
            "plan_id": self.plan["id"],
            "arrived_orders": len(all_jobs),
            "completed_by_cutoff": len(finished_by_close),
            "unfinished_at_cutoff": len(all_jobs) - len(finished_by_close),
            "completion_ratio_by_cutoff": round(
                len(finished_by_close) / len(all_jobs), 4
            )
            if all_jobs
            else 1.0,
            "completed_eventually": len(finished),
            "avg_queue_wait_sec": round(statistics.mean(waits), 3) if waits else None,
            "p90_queue_wait_sec": percentile(waits),
            "avg_elapsed_sec": round(statistics.mean(elapsed), 3) if elapsed else None,
            "p90_elapsed_sec": percentile(elapsed),
            "post_order_receipt_over_300_sec_ratio": round(
                sum(t > 300 for t in post_order_waits) / len(finished), 4
            )
            if finished
            else None,
            "avg_post_order_receipt_sec": round(statistics.mean(post_order_waits), 3)
            if post_order_waits
            else None,
            "p90_post_order_receipt_sec": percentile(post_order_waits),
            "served90_post_order_receipt_sec": served_by(post_order_waits),
            "overtime_to_drain_min": round(drain_sec / 60, 3),
            "stage_queue_wait_sec": stage_wait,
            "main_queue_bottleneck_stage": bottleneck,
            "equipment_utilization": {
                name: round(
                    sum(
                        max(
                            0,
                            min(
                                t["ended_at"]
                                if t["ended_at"] is not None
                                else t["started_at"] + t["seconds"],
                                self.day_end,
                            )
                            - t["started_at"],
                        )
                        for t in tasks
                        if t["equipment"] == name and t["started_at"] is not None
                    )
                    / (self.day_end * count),
                    4,
                )
                for name, count in self.equipment_counts.items()
            },
            "max_equipment_concurrency": dict(self.max_equipment_busy),
            "employee_utilization_during_day": {
                w["id"]: round(
                    sum(
                        max(
                            0,
                            min(
                                t["ended_at"]
                                if t["ended_at"] is not None
                                else t["started_at"] + t["seconds"],
                                self.day_end,
                            )
                            - t["started_at"],
                        )
                        for t in tasks
                        if t.get("assigned_worker") == w["id"]
                        and t["started_at"] is not None
                    )
                    / self.day_end,
                    4,
                )
                for w in self.workers
            },
            "employee_utilization_during_shift": {},
            "menu_order_counts": dict(menu_counts),
            "staff_hours": staff_hours,
            "staff_changes": changes,
            "roster": self.roster_segments,
            "by_slot": self._slot_summary(),
            "events": self.events,
            "metric_basis": "Accepted orders are finished so waits can be measured; overtime_to_drain_min and unfinished_at_cutoff (open at 19:00) are reference figures only. post_order_receipt measures order-end to handoff, not arrival to handoff.",
        }

    def _begin(self, task, worker=None):
        if worker is not None:
            task["assigned_worker"] = worker["id"]
        super()._begin(task, worker)
