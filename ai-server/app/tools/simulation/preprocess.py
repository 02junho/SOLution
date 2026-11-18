"""서울시 상권분석서비스 추정매출(을지로입구역·커피) 원본 → 시뮬레이션 구간 비중 전처리.

원본 공공데이터는 저장소 규칙대로 data/public/에 둔다. 엔진은 실행 중에 원본을 읽지 않고,
이 스크립트가 만든 data/demand_shares.json(도구 폴더 안)만 읽는다. ai-server Docker 이미지는
ai-server/app만 복사하므로, 엔진이 쓰는 파일은 도구 폴더 안에 있어야 한다.

원본을 바꿨을 때만 다시 실행한다(ai-server 폴더에서):
    python -m app.tools.simulation.preprocess

금액 열과 점포 수는 쓰지 않는다. 상권 결제 건수를 매장 주문 수로 해석하지 않는다.
"""

from __future__ import annotations
import csv
import json
import math
from pathlib import Path
from statistics import median

ROOT = Path(__file__).resolve().parent
REPO_ROOT = Path(__file__).resolve().parents[4]
RAW = REPO_ROOT / "data" / "public" / "seoul_sales_euljiro_coffee_2024q1_2026q2.csv"
DERIVED = ROOT / "data" / "demand_shares.json"
SLOTS = (
    ("07:00", "11:00", 4, "시간대_06~11_매출_건수", 4 / 5),
    ("11:00", "14:00", 3, "시간대_11~14_매출_건수", 1),
    ("14:00", "17:00", 3, "시간대_14~17_매출_건수", 1),
    ("17:00", "19:00", 2, "시간대_17~21_매출_건수", 2 / 4),
)
QUARTERS = [f"{y}{q}" for y in (2024, 2025) for q in range(1, 5)] + ["20261", "20262"]


def read_source():
    with RAW.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    chosen = [
        r
        for r in rows
        if r["상권_코드_명"] == "을지로입구역" and r["서비스_업종_코드"] == "CS100010"
    ]
    by = {r["기준_년분기_코드"]: r for r in chosen}
    if len(chosen) != 10 or sorted(by) != sorted(QUARTERS):
        raise ValueError(
            "CSV must have exactly 2024Q1-2026Q2 Euljiro entrance coffee records"
        )
    for q, r in by.items():
        keys = (
            ["시간대_00~06_매출_건수"]
            + [t[3] for t in SLOTS]
            + ["시간대_21~24_매출_건수"]
        )
        if sum(int(r[k]) for k in keys) != int(r["당월_매출_건수"]):
            raise ValueError(f"Raw time-band counts mismatch the total for {q}")
    return by


def build(write=True):
    source = read_source()
    rows = []
    for q in QUARTERS:
        src = source[q]
        actual = [int(src[k]) for *_, k, factor in SLOTS]
        adjusted = [a * t[4] for a, t in zip(actual, SLOTS)]
        total = sum(adjusted)
        d = {
            "quarter": q,
            "area": "을지로입구역",
            "industry": "CS100010",
            "raw_06_11": actual[0],
            "raw_11_14": actual[1],
            "raw_14_17": actual[2],
            "raw_17_21": actual[3],
            "estimate_07_11": adjusted[0],
            "observed_11_14": adjusted[1],
            "observed_14_17": adjusted[2],
            "estimate_17_19": adjusted[3],
            "estimated_total_07_19": total,
            "share_07_11": adjusted[0] / total,
            "share_11_14": adjusted[1] / total,
            "share_14_17": adjusted[2] / total,
            "share_17_19": adjusted[3] / total,
        }
        rows.append(d)
    # Exactly preserve the V5 P50 definition: median of slot PAYMENT COUNTS, then normalize.
    medians = [
        median([r[col] for r in rows])
        for col in (
            "estimate_07_11",
            "observed_11_14",
            "observed_14_17",
            "estimate_17_19",
        )
    ]
    medsum = sum(medians)
    p50 = [v / medsum for v in medians]
    if not math.isclose(sum(p50), 1, abs_tol=1e-12):
        raise AssertionError("Shares do not sum to 1")
    result = {
        "source_file": RAW.name,
        "source_encoding": "utf-8-sig",
        "area": "을지로입구역",
        "area_code": source["20262"]["상권_코드"],
        "industry_code": "CS100010",
        "industry": "커피-음료",
        "quarters": QUARTERS,
        "metric": "상권 전체 시간대별 카드 결제 건수",
        "source_bands": ["06:00-11:00", "11:00-14:00", "14:00-17:00", "17:00-21:00"],
        "simulation_bands": [f"{s}-{e}" for s, e, *_ in SLOTS],
        "adjustment_factors": [0.8, 1, 1, 0.5],
        "method": "P50 of 10 quarter-wise adjusted source payment counts for each band, divided by their four-band sum",
        "assumption": "Within each source band, equal number of card transactions per clock hour; 06-07 and 19-21 excluded.",
        "limitations": "Data is commercial-area card payment counts, not orders/customers of a store. No store demand forecast. Partial bands are estimates, not observations.",
        "p50_adjusted_counts": dict(zip([f"{s}-{e}" for s, e, *_ in SLOTS], medians)),
        "normalized_shares": dict(zip([f"{s}-{e}" for s, e, *_ in SLOTS], p50)),
        "per_quarter": rows,
    }
    if write:
        DERIVED.parent.mkdir(exist_ok=True)
        DERIVED.write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    return result


def load():
    """엔진이 실행 중에 쓰는 값. 원본 CSV 없이 미리 계산한 결과만 읽는다."""
    return json.loads(DERIVED.read_text(encoding="utf-8"))


if __name__ == "__main__":
    x = build()
    print(json.dumps(x["normalized_shares"], ensure_ascii=False, indent=2))
