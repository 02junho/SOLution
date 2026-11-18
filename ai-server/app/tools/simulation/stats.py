"""Paired comparison of repeated runs (URQ-CMP-001·002).

All plans share the same customer draws inside one run, so plan differences are
compared run by run. The 95% interval uses Student's t; no SciPy dependency.
"""

from __future__ import annotations
import math
import statistics

# Two-sided 95% (0.975 quantile) for df 1..30. Larger df use a series expansion.
_T975 = [
    12.7062,
    4.3027,
    3.1824,
    2.7764,
    2.5706,
    2.4469,
    2.3646,
    2.3060,
    2.2622,
    2.2281,
    2.2010,
    2.1788,
    2.1604,
    2.1448,
    2.1314,
    2.1199,
    2.1098,
    2.1009,
    2.0930,
    2.0860,
    2.0796,
    2.0739,
    2.0687,
    2.0639,
    2.0595,
    2.0555,
    2.0518,
    2.0484,
    2.0452,
    2.0423,
]


def t_critical_95(df: int) -> float:
    if df < 1:
        raise ValueError("df must be at least 1")
    if df <= len(_T975):
        return _T975[df - 1]
    z = 1.959964
    # Cornish-Fisher expansion; error < 1e-4 for df > 30.
    return z + (z**3 + z) / (4 * df) + (5 * z**5 + 16 * z**3 + 3 * z) / (96 * df**2)


def paired_difference(
    baseline: list, other: list, lower_is_better: bool = True
) -> dict:
    """other − baseline per run. "no_difference" when the 95% interval includes 0 (CMP-002)."""
    if len(baseline) != len(other):
        raise ValueError("paired runs must have the same length")
    diffs = [o - b for b, o in zip(baseline, other) if b is not None and o is not None]
    n = len(diffs)
    if n == 0:
        return {
            "runs": 0,
            "mean_diff": None,
            "ci95_low": None,
            "ci95_high": None,
            "better_runs": None,
            "verdict": "not_available",
        }
    mean = statistics.mean(diffs)
    if n == 1:
        low = high = mean
    else:
        half = t_critical_95(n - 1) * statistics.stdev(diffs) / math.sqrt(n)
        low, high = mean - half, mean + half
    better = sum((d < 0) if lower_is_better else (d > 0) for d in diffs)
    if n < 2 or low <= 0 <= high:
        verdict = "no_difference"
    elif (high < 0) == lower_is_better:
        verdict = "better"
    else:
        verdict = "worse"
    return {
        "runs": n,
        "mean_diff": round(mean, 3),
        "ci95_low": round(low, 3),
        "ci95_high": round(high, 3),
        "better_runs": better,
        "verdict": verdict,
    }
