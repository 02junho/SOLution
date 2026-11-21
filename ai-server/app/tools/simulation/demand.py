"""Euljiro-entrance daily demand assumptions and common random arrivals.

The public commercial district data determines SLOT SHARES only, never per-store order counts.
A full 07:00-19:00 day is modeled with *continuous* arrivals / shared queue across bands.
"""

from __future__ import annotations
from functools import lru_cache
from math import floor
import random
from .preprocess import load, SLOTS, QUARTERS
from . import day_window

# 기본 영업시간(07~19시) 값. 계산은 scenario의 start·end(day_window)를 쓴다.
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


def _band_hours(day):
    edges = [day_window.to_sec(t) for t in day.edges]
    hours = [(b - a) / 3600 for a, b in zip(edges, edges[1:])]
    return [int(h) if h.is_integer() else h for h in hours]


def get_shares(method="p50", quarter=None, day=None):
    """시간대 비중. 영업시간이 기본(07~19시)과 다르면 첫·마지막 시간대 건수를 시간 길이에 비례해 늘이거나 줄인다
    (원본 시간대 안에서 시간당 결제 건수가 같다는 기존 가정 그대로). 기본 영업시간이면 값이 전과 같다."""
    day = day or day_window.DEFAULT
    data = normalization()
    if method == "p50":
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
    else:
        raise ValueError("share_method must be p50/latest/quarter")
    base_hours = [t[2] for t in SLOTS]
    hours = _band_hours(day)
    counts = [
        c if h == b else c / b * h for c, h, b in zip(counts, hours, base_hours)
    ]
    if method == "p50" and day.is_default:
        values = list(data["normalized_shares"].values())
    else:
        values = [v / sum(counts) for v in counts]
    # 원본 시간대(06~11시 5시간, 17~21시 4시간) 중 쓰는 비율.
    factors = [hours[0] / 5, 1, 1, hours[3] / 4]
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
                "hours": h,
                "adjusted_payment_count": round(c, 3),
                "share": v,
                "was_partially_estimated": i in (0, 3),
            }
            for i, ((s, e), h, v, c) in enumerate(
                zip(
                    [x.split("-") for x in day.slots], hours, values, counts
                )
            )
        ],
        "adjustment_factors": [round(f, 4) for f in factors],
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
    day = day_window.from_scenario(spec)
    close_abs = day.open_abs + day.length
    last = spec.get("last_order_time") or day.clock(day.length - 15 * 60)
    last_secs = hhmm(last)
    if not day.open_abs < last_secs <= close_abs:
        raise ValueError(f"last_order_time must be after {day.open} and no later than {day.close}")
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
    labels = list(day.slots)
    if day.is_store:
        # 가게가 넣은 시간대별 주문 수만 쓴다. 상권 비중은 쓰지 않는다.
        share = {
            "area": "을지로입구역",
            "basis": "STORE_ENTERED_SLOT_ORDER_COUNTS",
            "time_bands": [
                {"start": s.split("-")[0], "end": s.split("-")[1]} for s in labels
            ],
        }
    else:
        share = get_shares(spec.get("share_method", "p50"), spec.get("quarter"), day)
    weights = [x.get("share", 0) for x in share["time_bands"]]
    if day.is_store and provided[0] != "orders_by_slot":
        raise ValueError("가게 시간대는 시간대별 주문 수(orders_by_slot)와 함께만 쓸 수 있어요.")
    if provided[0] == "orders_by_slot":
        source = spec["orders_by_slot"]
        if (
            not isinstance(source, dict)
            or set(source) != set(labels)
            or any(type(v) != int or v < 0 or v > 5000 for v in source.values())
        ):
            raise ValueError(
                f"orders_by_slot requires nonnegative integer counts for {labels}"
            )
        counts = [source[k] for k in labels]
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
        "id": "EULJIRO_ENTRANCE_" + _hours_id(day),
        "area": "을지로입구역",
        "start": day.open,
        "end": day.close,
        "last_order_time": last,
        "last_order_sec": last_secs - day.open_abs,
        "duration_min": day.length // 60,
        "slots": labels,
        "peak_start_time": day.peak[0],
        "peak_end_time": day.peak[1],
        "origin": origin,
        "planned_orders_before_last_order_filter": sum(counts),
        "orders_by_slot": dict(zip(labels, counts)),
        "takeout_ratio": ratio,
        "source": share,
        "applied_assumptions": [
            f"Entire {day.label} simulated without queue resets at band changes.",
            "Orders are distributed uniformly within each observed/estimated 4-hour/3-hour/2-hour time band.",
            f"With a last order earlier than {day.close}, rejected post-cutoff arrivals are NOT redistributed.",
            "Public district card payments determine shares only; customer/day volume comes from user or example.",
        ],
    }


def _hours_id(day):
    """기본 07~19시는 예전 그대로 0719. 30분이 섞이면 0730_1900처럼 분까지 쓴다."""
    if day.open.endswith(":00") and day.close.endswith(":00"):
        return day.open[:2] + day.close[:2]
    return day.open.replace(":", "") + "_" + day.close.replace(":", "")


def draw_orders(scn: dict, seed: int, service_stddev: dict | None = None):
    if type(seed) != int or not 0 <= seed <= 2**31 - 1:
        raise ValueError("random_seed out of range")
    rng = random.Random(seed)
    rows = []
    rejected = 0
    open_abs = hhmm(scn["start"])
    for label in scn["orders_by_slot"]:
        a, b = label.split("-")
        start = hhmm(a) - open_abs
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
