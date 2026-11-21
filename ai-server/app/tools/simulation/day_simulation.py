"""One-day cafe simulation (open to close, default 07:00-19:00, last order before close).

New arrivals stop at the last order time. Orders already accepted are finished so
that their waiting time can be measured; employees on the final roster finish them.
How long that tail runs past 19:00 is reported for reference only. It is not a
quality gate and is not added to staff hours. This is NOT a payroll planner.
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
    """Time by which at least `share` of the customers were served (nearest rank, no interpolation).

    `served_by(waits) <= limit` is exactly "share of customers waited <= limit", so pass checks use it.
    The interpolated percentile() stays for display only.
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
    # Each roster covers the full working day. "three": before peak / peak / after peak.
    # "four": one segment per demand time slot (four by default, N for store data).
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
    """Day plans for the three-plan comparison (team decision 11.11): A and C apply only 11~14,
    the other hours run as CURRENT. Other hours are covered by the per-slot recommendation."""
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
    ):
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
        at = self.clock.now if at is None else at
        if at >= self.day_end:
            # The final on-duty employees finish orders already accepted.
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
        """End of a continuous set of segments where this employee is present."""
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
        # A worker present at 19:00 may finish accepted orders after closing.
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
        for group in self._worker_groups(worker):
            eligible = [
                t
                for t in self.queue
                if t["stage"] in group and self._worker_can_start(worker, t)
            ]
            if eligible:
                return min(eligible, key=lambda t: t["seq"])
        return None

    def _slot_summary(self):
        jobs = list(self.jobs.values())
        byslot = []
        for label in self.day.slots:
            lo, hi = map(seconds, label.split("-"))
            arrived = [j for j in jobs if lo <= j["arrival_sec"] < hi]
            done = [j for j in jobs if j.get("completed_at_sec") is not None]
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
            task_all = [t for j in jobs for t in j["tasks"]]

            def busy_overlap(task):
                start = task["started_at"]
                if start is None:
                    return 0.0
                end = (
                    task["ended_at"]
                    if task["ended_at"] is not None
                    else start + task["seconds"]
                )
                return max(0.0, min(end, hi) - max(start, lo))

            equipment_util = {
                name: round(
                    sum(busy_overlap(t) for t in task_all if t["equipment"] == name)
                    / ((hi - lo) * count),
                    4,
                )
                for name, count in self.equipment_counts.items()
            }
            staff_util = {
                w["id"]: round(
                    sum(
                        busy_overlap(t)
                        for t in task_all
                        if t.get("assigned_worker") == w["id"]
                    )
                    / (hi - lo),
                    4,
                )
                for w in self.workers
            }
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

    def simulate(self):
        # Log the resources assigned to each task for per-slot busy fractions.
        for boundary in sorted({r["start_sec"] for r in self.roster_segments[1:]}):
            self.clock.schedule(boundary, self.dispatch)
        for order in self.orders:
            self.clock.schedule(order["arrival_sec"], lambda o=order: self.arrival(o))
        # The last roster handles any accepted orders remaining at 19:00.
        # Guard the virtual horizon and fail explicitly if the queue cannot drain.
        horizon = self.day_end + 3600 * max(4, len(self.orders) + 1)
        self.clock.run(horizon)
        finished = sorted(self.finished, key=lambda j: j["completed_at_sec"])
        all_jobs = list(self.jobs.values())
        assert len(all_jobs) == len(self.orders)
        if len(finished) != len(self.orders):
            raise RuntimeError(
                f"Accepted orders did not finish: {len(finished)}/{len(self.orders)}"
            )
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
