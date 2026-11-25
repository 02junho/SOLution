"""Spring 내부 호출용 인건비·배치표 라우터."""

import time

from fastapi import APIRouter, Depends, HTTPException

from app.core.execution_log import LOG_STATUS, write_tool_log
from app.core.request_key import get_request_key
from app.core.response import ApiResponse
from app.tools.labor import service
from app.schemas.labor import CostRequest, ScheduleRequest

router = APIRouter(tags=["labor"])


def _run(name, body, request_key, calculation):
    started = time.perf_counter()
    try:
        result = calculation(body)
    except ValueError as exc:
        _log(name, body, request_key, "failed", started, {"response_status": "error"})
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception:
        _log(name, body, request_key, "failed", started, {"response_status": "error"})
        raise
    _log(name, body, request_key, LOG_STATUS[result.status.value], started,
         {"response_status": result.status.value, "plan_count": len(body.plans), "policy_version": "v1"})
    return result


def _log(name, body, request_key, status, started, payload):
    write_tool_log(name=name, session_id=body.session_id, input_version_id=body.input_version_id,
                   request_key=request_key, status=status, latency_ms=int((time.perf_counter()-started)*1000), payload=payload)


@router.post("/cost")
def labor_cost(body: CostRequest, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    return _run("labor_cost", body, request_key, service.calculate_cost)


@router.post("/schedule")
def labor_schedule(body: ScheduleRequest, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    return _run("labor_schedule", body, request_key, service.create_schedule)
