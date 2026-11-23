"""대기열 재생 기록(URQ-CMP-003)을 execution_log에 남긴다. log_type = 'simulation_trace'.

Spring 결과 조회 API(OperationResultService.trace)가 log_id로 이 기록을 읽고, 화면(QueueReplay)이 그린다.
FastAPI가 쓰고 Spring은 읽기만 한다. 기록 형식은 Spring이 검사하는 operation.trace.v2다.
- 사건: ARRIVED · ORDER_STARTED · ORDER_COMPLETED · PREPARATION_STARTED · PREPARATION_COMPLETED ·
        HANDOFF_STARTED · HANDED_OVER · STAFF_ON · STAFF_OFF
- 시각: 오픈 시각(기본 07:00:00)부터 지난 초(at_seconds). 시작 상태(initial_state)는 개점 때의 빈 매장.
안마다 1번째 반복 하나를 남긴다. 기록이 실패하면 trace_refs를 비워 두고 계산 결과는 그대로 돌려준다.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

TRACE_SCHEMA_VERSION = "operation.trace.v2"
TIME_ORIGIN = "07:00:00"
DAY_END_SECONDS = 12 * 3600
# 엔진 로그는 반복 하나에 사건 10,000개까지 모은다(engine.SlotCafe.log). 넘으면 부분 기록으로 표시한다.
ENGINE_EVENT_CAP = 10000


def _engine_to_trace(events: list[dict]) -> list[dict]:
    """엔진 사건(queue_enter·start·end·completed·arrival) → Spring 재생 사건. 시각 순서는 엔진 기록 순서를 지킨다."""
    out: list[dict] = []
    preparing: set[str] = set()

    def add(at, kind, customer=None, worker=None):
        out.append(
            {
                "at_seconds": round(float(at), 3),
                "event_type": kind,
                "customer_key": customer,
                "worker_key": worker,
            }
        )

    for e in events:
        at, kind, stage = e["time_sec"], e["event_type"], e.get("stage")
        customer = str(e["order_id"])
        worker = e.get("employee_id")
        if kind == "arrival":
            add(at, "ARRIVED", customer)
        elif stage == "order" and kind == "start":
            add(at, "ORDER_STARTED", customer, worker)
        elif stage == "order" and kind == "end":
            add(at, "ORDER_COMPLETED", customer, worker)
        elif stage == "preparation" and kind == "start" and customer not in preparing:
            preparing.add(customer)  # 여러 제조 단계 중 첫 단계 시작
            add(at, "PREPARATION_STARTED", customer, worker)
        elif stage == "handoff" and kind == "queue_enter":
            if customer in preparing:  # 마지막 제조 단계가 끝나 전달 줄에 섰다
                add(at, "PREPARATION_COMPLETED", customer)
        elif stage == "handoff" and kind == "start":
            add(at, "HANDOFF_STARTED", customer, worker)
        elif kind == "completed":
            add(at, "HANDED_OVER", customer, worker)
    return out


def _staff_events(roster: list[dict]) -> tuple[list[str], list[dict]]:
    """구간표 → 개점 때 일하는 직원과 구간 경계의 출근(STAFF_ON)·퇴근(STAFF_OFF). 마감 뒤 마무리는 퇴근으로 치지 않는다."""
    if not roster:
        return [], []
    first = list(roster[0]["workers"])
    out = []
    for before, after in zip(roster, roster[1:]):
        at = after["start_sec"]
        for key in before["workers"]:
            if key not in after["workers"]:
                out.append(
                    {
                        "at_seconds": float(at),
                        "event_type": "STAFF_OFF",
                        "customer_key": None,
                        "worker_key": key,
                    }
                )
        for key in after["workers"]:
            if key not in before["workers"]:
                out.append(
                    {
                        "at_seconds": float(at),
                        "event_type": "STAFF_ON",
                        "customer_key": None,
                        "worker_key": key,
                    }
                )
    return first, out


def build_payload(
    plan: dict, repetitions: int, scenario: dict | None = None
) -> dict:
    """compare 결과의 한 안(results[])을 재생용 payload로 바꾼다. 수치는 다시 계산하지 않는다."""
    engine_events = plan.get("first_run_events") or []
    active, staff = _staff_events(plan.get("first_run_roster") or [])
    # 같은 시각이면 직원 출퇴근을 먼저, 그다음 엔진 기록 순서(정렬은 안정 정렬).
    rows = sorted(
        staff + _engine_to_trace(engine_events), key=lambda r: r["at_seconds"]
    )
    events = [{"sequence_no": i, **row} for i, row in enumerate(rows, start=1)]
    return {
        "trace_schema_version": TRACE_SCHEMA_VERSION,
        "choice_key": plan["choice_key"],
        "replication_no": 1,
        "completed_repetitions": repetitions,
        "time_origin": f"{scenario['start']}:00" if scenario else TIME_ORIGIN,
        "time_unit": "seconds",
        "observation_window": {
            "start_seconds": 0,
            "end_seconds": scenario["duration_min"] * 60 if scenario else DAY_END_SECONDS,
        },
        "initial_state": {
            "active_staff_keys": active,
            "customers": [],
            "order_queue": [],
            "preparation_queue": [],
            "in_service": [],
            "completed_customer_count": 0,
        },
        "is_complete": len(engine_events) < ENGINE_EVENT_CAP,
        "event_count": len(events),
        "events": events,
    }


def write_traces(
    data: dict,
    *,
    session_id: int,
    input_version_id: int | None,
    result_id: int,
    request_key: str,
) -> list[dict]:
    """안마다 기록 1건. 성공한 기록만 trace_refs로 돌려준다."""
    try:
        from psycopg.types.json import Jsonb
        from app.core.db import get_pool
        from app.core.execution_log import (
            _next_id,
        )  # Spring IdGenerator와 같은 번호 규칙
    except Exception as exc:  # DB 패키지가 없는 개발 환경
        logger.warning("simulation_trace 기록 생략: %s", exc)
        return []
    refs = []
    for plan in data.get("results", []):
        if not plan.get("first_run_events"):
            continue
        log_id = _next_id()
        payload = build_payload(plan, data.get("repetitions", 0), data.get("scenario"))
        try:
            with get_pool().connection(timeout=1) as conn:
                conn.execute(
                    """
                    INSERT INTO execution_log
                        (log_id, session_id, input_version_id, log_type, request_key, result_id, name, status, payload_json)
                    VALUES (%s, %s, %s, 'simulation_trace', %s, %s, %s, 'success', %s)
                    """,
                    (
                        log_id,
                        session_id,
                        input_version_id,
                        f"{request_key}:trace:{plan['choice_key']}",
                        result_id,
                        "simulation_trace",
                        Jsonb(payload),
                    ),
                )
        except Exception as exc:
            logger.warning(
                "simulation_trace 기록 실패 (%s): %s", plan["choice_key"], exc
            )
            continue
        refs.append(
            {
                "result_id": result_id,
                "log_id": log_id,
                "choice_key": plan["choice_key"],
                "replication_no": 1,
                "is_complete": payload["is_complete"],
            }
        )
    return refs
