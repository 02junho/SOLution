"""execution_log에 도구 호출 기록을 남긴다. 기록이 실패해도 응답은 그대로 돌려준다 (best effort).

토큰·개인정보·원문 입력은 넣지 않는다. payload에는 상태와 개수 같은 요약만 넣는다.
"""

from __future__ import annotations

import logging
import threading
import time

from psycopg.types.json import Jsonb

from app.core.db import get_pool

logger = logging.getLogger(__name__)

_lock = threading.Lock()
_last_id = 0

# 공통 응답 status → execution_log.status
LOG_STATUS = {"ok": "success", "infeasible": "success", "needs_input": "incomplete", "error": "failed"}


def _next_id() -> int:
    """밀리초×1000 + 순번. Spring의 IdGenerator와 같은 규칙."""
    global _last_id
    with _lock:
        candidate = int(time.time() * 1000) * 1000
        _last_id = max(candidate, _last_id + 1)
        return _last_id


def write_tool_log(
    *,
    name: str,
    session_id: int,
    input_version_id: int | None,
    request_key: str,
    status: str,
    latency_ms: int,
    payload: dict,
) -> None:
    try:
        with get_pool().connection(timeout=1) as conn:
            conn.execute(
                """
                INSERT INTO execution_log
                    (log_id, session_id, input_version_id, log_type, request_key, name, status, latency_ms, payload_json)
                VALUES (%s, %s, %s, 'tool', %s, %s, %s, %s, %s)
                """,
                (_next_id(), session_id, input_version_id, request_key, name, status, latency_ms, Jsonb(payload)),
            )
    except Exception as exc:  # 기록 실패로 계산 결과를 막지 않는다.
        logger.warning("execution_log 기록 실패 (%s): %s", name, exc)
