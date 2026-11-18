"""Core event/task/resource scheduler. The day simulation (day_simulation.DayCafe) builds on it.

Also exposes a pure-Python reference clock for offline tests (not the actual SimPy engine).
When SimPy is installed, the engine uses simpy.Environment and simpy.Resource.
"""

from __future__ import annotations
from collections import defaultdict
import heapq


class ReferenceClock:
    def __init__(self):
        self.now = 0.0
        self.queue = []
        self.serial = 0
        self.env = None

    def schedule(self, at, callback):
        if at < self.now - 1e-9:
            raise AssertionError("Event scheduled in the past")
        self.serial += 1
        heapq.heappush(self.queue, (float(at), self.serial, callback))

    def run(self, until):
        while self.queue and self.queue[0][0] <= until:
            at, _, cb = heapq.heappop(self.queue)
            self.now = at
            cb()
        self.now = until


class SimPyClock:
    """A true SimPy environment: every event is its own SimPy process.

    This ensures a new machine-completion event inserted between previously
    scheduled arrivals is processed on time, rather than behind a sleeping
    heap dispatcher.
    """

    def __init__(self):
        import simpy

        self.simpy = simpy
        self.env = simpy.Environment()

    @property
    def now(self):
        return float(self.env.now)

    def schedule(self, at, callback):
        if at < self.now - 1e-9:
            raise AssertionError("Event scheduled in the past")

        def event_process():
            yield self.env.timeout(max(0.0, at - self.env.now))
            callback()

        self.env.process(event_process())

    def run(self, until):
        self.env.run(until=until)


class SlotCafe:
    def __init__(
        self, orders, plan, config, slot, clock_mode="simpy", include_events=False
    ):
        if clock_mode == "simpy":
            self.clock = SimPyClock()
        elif clock_mode == "reference":
            self.clock = ReferenceClock()
        else:
            raise ValueError("engine must be simpy or reference")
        self.slot = slot
        self.end_sec = slot[2]
        self.orders = orders
        self.config = config
        self.plan = plan
        self.workers = []
        for worker in plan["employees"]:
            self.workers.append(
                {
                    "id": worker["id"],
                    "groups": worker["priority_groups"],
                    "busy": False,
                    "ticket": None,
                }
            )
        if not self.workers:
            raise ValueError("No workers in this slot")
        self.equipment_counts = dict(config["catalog"]["equipment_counts"])
        self.equipment_busy = {k: 0 for k in self.equipment_counts}
        self.max_equipment_busy = {k: 0 for k in self.equipment_counts}
        self.equipment_busy_sec = {k: 0.0 for k in self.equipment_counts}
        if self.clock.env is not None:
            simpy = self.clock.simpy
            self.equipment_resources = {
                k: simpy.Resource(self.clock.env, capacity=n)
                for k, n in self.equipment_counts.items()
            }
            self.worker_resources = {
                w["id"]: simpy.Resource(self.clock.env, capacity=1)
                for w in self.workers
            }
        else:
            self.equipment_resources = {}
            self.worker_resources = {}
        self.queue = []
        self.serial = 0
        self.running = False
        self.finished = []
        self.events = []
        self.log_enabled = include_events
        self.jobs = {}
        self.worker_busy_sec = defaultdict(float)

    def log(self, job, task, event, worker=None):
        if self.log_enabled and len(self.events) < 10000:
            self.events.append(
                {
                    "time_sec": round(self.clock.now, 3),
                    "event_type": event,
                    "order_id": job["order_id"],
                    "menu_id": job["menu_id"],
                    "stage": task.get("stage") if task else "arrival",
                    "phase": task.get("phase") if task else None,
                    "employee_id": worker,
                    "equipment": task.get("equipment") if task else None,
                }
            )

    def _queue_task(
        self, job, stage, phase, seconds, needs_worker=True, equipment=None
    ):
        self.serial += 1
        task = {
            "job": job,
            "stage": stage,
            "phase": phase,
            "seconds": float(seconds),
            "needs_worker": needs_worker,
            "equipment": equipment,
            "queued_at": self.clock.now,
            "started_at": None,
            "ended_at": None,
            "seq": self.serial,
            "ticket": None,
        }
        self.queue.append(task)
        job["tasks"].append(task)
        self.log(job, task, "queue_enter")
        return task

    def _claim_equipment(self, task):
        name = task["equipment"]
        if name is None:
            return
        if self.equipment_busy[name] >= self.equipment_counts[name]:
            raise AssertionError("Equipment overallocated")
        self.equipment_busy[name] += 1
        self.max_equipment_busy[name] = max(
            self.equipment_busy[name], self.max_equipment_busy[name]
        )
        self.equipment_busy_sec[name] += max(
            0.0,
            min(self.clock.now + task["seconds"], self.end_sec)
            - min(self.clock.now, self.end_sec),
        )
        if self.clock.env is not None:
            ticket = self.equipment_resources[name].request()
            assert ticket.triggered, "SimPy equipment claim unexpectedly queued"
            task["ticket"] = ticket

    def _release_equipment(self, task):
        name = task["equipment"]
        if name is None:
            return
        if not self.equipment_busy[name]:
            raise AssertionError("Equipment released twice")
        self.equipment_busy[name] -= 1
        if self.clock.env is not None:
            self.equipment_resources[name].release(task["ticket"])

    def _claim_worker(self, worker):
        if worker["busy"]:
            raise AssertionError("Employee double-booked")
        worker["busy"] = True
        if self.clock.env is not None:
            ticket = self.worker_resources[worker["id"]].request()
            assert ticket.triggered, "SimPy employee claim unexpectedly queued"
            worker["ticket"] = ticket

    def _release_worker(self, worker):
        if not worker["busy"]:
            raise AssertionError("Worker released twice")
        worker["busy"] = False
        if self.clock.env is not None:
            self.worker_resources[worker["id"]].release(worker["ticket"])
            worker["ticket"] = None

    def _begin(self, task, worker=None):
        self.queue.remove(task)
        task["started_at"] = self.clock.now
        job = task["job"]
        stage = task["stage"]
        job["wait_sec"][stage] += max(0.0, self.clock.now - task["queued_at"])
        if worker is not None:
            self._claim_worker(worker)
            self.worker_busy_sec[worker["id"]] += max(
                0.0,
                min(self.clock.now + task["seconds"], self.end_sec)
                - min(self.clock.now, self.end_sec),
            )
        self._claim_equipment(task)
        self.log(job, task, "start", worker["id"] if worker else None)
        self.clock.schedule(
            self.clock.now + task["seconds"],
            lambda t=task, w=worker: self._finish(t, w),
        )

    def _finish(self, task, worker):
        task["ended_at"] = self.clock.now
        if task["equipment"] is not None:
            self._release_equipment(task)
        if worker is not None:
            self._release_worker(worker)
        job = task["job"]
        self.log(job, task, "end", worker["id"] if worker else None)
        if task["stage"] == "order":
            self._next_preparation(job)
        elif task["stage"] == "preparation":
            self._next_preparation(job)
        else:
            job["completed_at_sec"] = self.clock.now
            job["elapsed_sec"] = self.clock.now - job["arrival_sec"]
            job["queue_wait_sec"] = sum(job["wait_sec"].values())
            self.finished.append(job)
            self.log(job, task, "completed")
        self.dispatch()

    def _next_preparation(self, job):
        steps = job["prepared_steps"]
        index = job["next_step_index"]
        if index == len(steps):
            sec = max(
                1.0,
                self.config["handoff_time_sec"]
                + job["standard_normal_draws"]["handoff"]
                * self.config["handoff_stddev_sec"],
            )
            if job["order_type"] == "takeout":
                sec += self.config["takeout_extra_handoff_sec"]
            self._queue_task(job, "handoff", "handoff", sec)
        else:
            step = steps[index]
            job["next_step_index"] += 1
            self._queue_task(
                job,
                "preparation",
                step["name"],
                step["seconds"],
                step["worker"],
                step["equipment"],
            )

    def arrival(self, job):
        job = {
            **job,
            "tasks": [],
            "wait_sec": {"order": 0.0, "preparation": 0.0, "handoff": 0.0},
            "next_step_index": 0,
        }
        self.jobs[job["order_id"]] = job
        sec = max(
            1.0,
            self.config["order_time_sec"]
            + job["standard_normal_draws"]["order"] * self.config["order_stddev_sec"],
        )
        self._queue_task(job, "order", "register", sec)
        self.log(job, None, "arrival")
        self.dispatch()

    def _worker_can_start(self, worker, task):
        if not task["needs_worker"]:
            return False
        if (
            task["equipment"] is not None
            and self.equipment_busy[task["equipment"]]
            >= self.equipment_counts[task["equipment"]]
        ):
            return False
        return True

    def _pick_task(self, worker):
        for group in worker["groups"]:
            eligible = [
                t
                for t in self.queue
                if t["stage"] in group and self._worker_can_start(worker, t)
            ]
            if eligible:
                return min(eligible, key=lambda t: t["seq"])
        return None

    def dispatch(self):
        if self.running:
            return
        self.running = True
        try:
            while True:
                changed = False
                # Automatic machine tasks do not occupy the employee.
                for task in sorted(self.queue, key=lambda t: t["seq"]):
                    eq = task["equipment"]
                    if (
                        not task["needs_worker"]
                        and eq is not None
                        and self.equipment_busy[eq] < self.equipment_counts[eq]
                    ):
                        self._begin(task)
                        changed = True
                for worker in self.workers:
                    if worker["busy"]:
                        continue
                    task = self._pick_task(worker)
                    if task is not None:
                        self._begin(task, worker)
                        changed = True
                if not changed:
                    break
        finally:
            self.running = False
