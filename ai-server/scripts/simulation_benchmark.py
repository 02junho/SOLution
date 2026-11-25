"""실행 시간 측정(URQ-SIM-010 제한 시간 정하기용). API가 아니며 개발자가 ai-server/에서 실행한다.

    PYTHONPATH=. python scripts/simulation_benchmark.py --engine simpy

Spring의 FastAPI 읽기 제한(read-timeout)은 120초다. 비교 1회가 이보다 충분히 짧아야 한다.
"""

from __future__ import annotations

import argparse
import time

from app.tools.simulation.simulation_service import compare, sensitivity


def measure(engine: str, orders: list[int], repetitions: int) -> list[dict]:
    rows = []
    for daily in orders:
        body = {
            "scenario": {"daily_orders": daily},
            "repetitions": repetitions,
            "include_events": True,
        }
        started = time.perf_counter()
        compare(body, engine=engine)
        rows.append(
            {
                "kind": "compare",
                "daily_orders": daily,
                "seconds": round(time.perf_counter() - started, 2),
            }
        )
    started = time.perf_counter()
    sensitivity(
        {"scenario": {"daily_orders": orders[0]}, "repetitions": repetitions},
        engine=engine,
    )
    rows.append(
        {
            "kind": "sensitivity",
            "daily_orders": orders[0],
            "seconds": round(time.perf_counter() - started, 2),
        }
    )
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description="운영 시뮬레이션 실행 시간 측정")
    parser.add_argument("--engine", choices=("simpy", "reference"), default="simpy")
    parser.add_argument("--orders", type=int, nargs="+", default=[150, 300])
    parser.add_argument("--repetitions", type=int, default=30)
    args = parser.parse_args(argv)
    for row in measure(args.engine, args.orders, args.repetitions):
        print(f"{row['kind']:<12} 하루 {row['daily_orders']}잔  {row['seconds']}초")


if __name__ == "__main__":
    main()
