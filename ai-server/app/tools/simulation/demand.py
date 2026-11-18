"""Euljiro-entrance daily demand assumptions and common random arrivals.

The public commercial district data determines SLOT SHARES only, never per-store order counts.
A full 07:00-19:00 day is modeled with *continuous* arrivals / shared queue across bands.
"""

from __future__ import annotations
from functools import lru_cache
from math import floor
import random
from .preprocess import load, SLOTS, QUARTERS

LABELS = [f"{a}-{b}" for a, b, *_ in SLOTS]
DAY_START = 7 * 3600
DAY_END = 19 * 3600
# Illustrative daily orders for demand_level, not measured. One table for every path.
DEMAND_PRESETS = {
    "low": 60,
    "medium": 100,
    "high": 150,
}


@lru_cache(maxsize=1)
def normalization():
    return load()


def hhmm(v: str) -> int:
    if not isinstance(v, str):
        raise ValueError("Time must be HH:MM")
    try:
        parts = v.split(":")
        hh, mm = map(int, parts)
        if len(parts) != 2 or not 0 <= hh <= 23 or not 0 <= mm < 60:
            raise ValueError()
    except Exception as e:
        raise ValueError(f"Invalid HH:MM: {v}") from e
    return hh * 3600 + mm * 60


def clock(n: float) -> str:
    return f"{int(n // 3600):02d}:{int(n % 3600 // 60):02d}"


def allocate(total: int, weights: list[float]):
    if type(total) is not int or not 0 <= total <= 5000:
        raise ValueError("Daily order count must be integer [0,5000]")
    if any(w < 0 for w in weights) or sum(weights) <= 0:
        raise ValueError("Invalid proportions")
    x = [total * w / sum(weights) for w in weights]
    b = [floor(z) for z in x]
    for i in sorted(range(len(x)), key=lambda i: (-(x[i] - b[i]), i))[: total - sum(b)]:
        b[i] += 1
    return b


def get_shares(method="p50", quarter=None):
    data = normalization()
    if method == "p50":
        values = list(data["normalized_shares"].values())
        counts = list(data["p50_adjusted_counts"].values())
    elif method in ("latest", "quarter"):
        q = QUARTERS[-1] if method == "latest" else quarter
        if q not in QUARTERS:
            raise ValueError("quarter must be 20241 ... 20262")
        row = next(r for r in data["per_quarter"] if r["quarter"] == q)
        counts = [
            row[k]
            for k in (
                "estimate_07_11",
                "observed_11_14",
                "observed_14_17",
                "estimate_17_19",
            )
        ]
        values = [v / sum(counts) for v in counts]
    else:
        raise ValueError("share_method must be p50/latest/quarter")
    return {
        "area": "을지로입구역",
        "source_period": "2024Q1-2026Q2",
        "share_method": method,
        "quarter": (
            QUARTERS[-1]
            if method == "latest"
            else quarter
            if method == "quarter"
            else None
        ),
        "time_bands": [
            {
                "start": s,
                "end": e,
                "hours": hours,
                "adjusted_payment_count": round(c, 3),
                "share": v,
                "was_partially_estimated": i in (0, 3),
            }
            for i, ((s, e, hours, *_), v, c) in enumerate(zip(SLOTS, values, counts))
        ],
        "adjustment_factors": [0.8, 1, 1, 0.5],
        "data_provenance": "서울시 상권분석 서비스: 을지로입구역 CS100010 시간대별 카드 결제 건수",
        "methodology": data["method"],
        "caveat": data["limitations"],
    }


def scenario(spec: dict):
    if not isinstance(spec, dict):
        raise ValueError("scenario must be an object")
    area = spec.get("area", "을지로입구역")
    if area != "을지로입구역":
        raise ValueError("demonstration area is fixed to 을지로입구역")
    if (
        spec.get("start_time", "07:00") != "07:00"
        or spec.get("end_time", "19:00") != "19:00"
    ):
        raise ValueError("continuous-day start/end fixed at 07:00-19:00")
    last = spec.get("last_order_time", "18:45")
    last_secs = hhmm(last)
    if not DAY_START < last_secs <= DAY_END:
        raise ValueError("last_order_time must be 07:01 to 19:00")
    provided = [
        k
        for k in ("daily_orders", "demand_level", "orders_by_slot")
        if spec.get(k) is not None
    ]
    if not provided:
        raise ValueError(
            "NEEDS_INPUT: specify daily_orders, demand_level or orders_by_slot"
        )
    if len(provided) != 1:
        raise ValueError(
            "Specify exactly one of daily_orders, demand_level or orders_by_slot"
        )
    share = get_shares(spec.get("share_method", "p50"), spec.get("quarter"))
    weights = [x["share"] for x in share["time_bands"]]
    if provided[0] == "orders_by_slot":
        source = spec["orders_by_slot"]
        if (
            not isinstance(source, dict)
            or set(source) != set(LABELS)
            or any(type(v) != int or v < 0 or v > 5000 for v in source.values())
        ):
            raise ValueError(
                f"orders_by_slot requires nonnegative integer counts for {LABELS}"
            )
        counts = [source[k] for k in LABELS]
        if sum(counts) > 5000:
            raise ValueError("Total orders must be <=5000")
        origin = "USER_ENTERED_SLOT_ORDER_COUNTS"
    else:
        if provided[0] == "demand_level":
            level = spec["demand_level"]
            if level not in DEMAND_PRESETS:
                raise ValueError("demand_level low/medium/high")
            n = DEMAND_PRESETS[level]
            origin = "ILLUSTRATIVE_PRESET_NOT_PREDICTED"
        else:
            n = spec["daily_orders"]
            origin = "USER_ENTERED_DAILY_ORDERS"
        counts = allocate(n, weights)
    ratio = spec.get("takeout_ratio", 0.4)
    if type(ratio) not in (float, int) or not 0 <= ratio <= 1:
        raise ValueError("takeout_ratio must be 0..1")
    return {
        "id": "EULJIRO_ENTRANCE_0719",
        "area": "을지로입구역",
        "start": "07:00",
        "end": "19:00",
        "last_order_time": last,
        "last_order_sec": last_secs - DAY_START,
        "duration_min": 720,
        "origin": origin,
        "planned_orders_before_last_order_filter": sum(counts),
        "orders_by_slot": dict(zip(LABELS, counts)),
        "takeout_ratio": ratio,
        "source": share,
        "applied_assumptions": [
            "Entire 07:00-19:00 simulated without queue resets at band changes.",
            "Orders are distributed uniformly within each observed/estimated 4-hour/3-hour/2-hour time band.",
            "With a last order earlier than 19:00, rejected post-cutoff arrivals are NOT redistributed.",
            "Public district card payments determine shares only; customer/day volume comes from user or example.",
        ],
    }


def draw_orders(scn: dict, seed: int, service_stddev: dict | None = None):
    if type(seed) != int or not 0 <= seed <= 2**31 - 1:
        raise ValueError("random_seed out of range")
    rng = random.Random(seed)
    rows = []
    rejected = 0
    for (a, b, *_), label in zip(SLOTS, LABELS):
        start = hhmm(a) - DAY_START
        length = hhmm(b) - hhmm(a)
        for j in range(scn["orders_by_slot"][label]):
            at = start + rng.random() * length
            takeout = rng.random() < scn["takeout_ratio"]
            draws = {st: rng.gauss(0, 1) for st in ("order", "preparation", "handoff")}
            if at >= scn["last_order_sec"]:
                rejected += 1
                continue
            rows.append(
                {
                    "arrival_sec": at,
                    "order_type": "takeout" if takeout else "dine_in",
                    "standard_normal_draws": draws,
                    "origin_slot": label,
                }
            )
    rows.sort(key=lambda x: x["arrival_sec"])
    for i, r in enumerate(rows, 1):
        r["order_id"] = f"ORD_{i:05d}"
    return rows, rejected
