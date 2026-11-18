"""4번 운영 도구: Spring -> FastAPI, /tools/simulation/{compare,sensitivity}.

팀 공통 ApiResponse/요청 키/execution_log만 사용하며 standalone 서버를 만들지 않는다.
프로덕션 API에서 참조 엔진(reference)은 노출하지 않는다.
"""

from __future__ import annotations

import time

from fastapi import APIRouter, Depends, HTTPException

from app.core.execution_log import LOG_STATUS, write_tool_log
from app.core.request_key import get_request_key
from app.core.response import ApiResponse, needs_input, ok
from .catalog import options
from app.schemas.simulation import CompareRequest, SensitivityRequest
from .trace_log import write_traces
from .simulation_service import compare, sensitivity
from .spring_contract import ContractError, build as to_contract
from .staffing_input import parse as parse_staffing

router = APIRouter()


def _validate_demand(body: CompareRequest) -> ApiResponse[dict] | None:
    scenario = body.scenario
    if all(
        getattr(scenario, key) is None
        for key in ("daily_orders", "demand_level", "orders_by_slot")
    ):
        return needs_input(
            data={
                "missing_fields": [
                    {
                        "path": "scenario.daily_orders",
                        "label": "하루 예상 주문량",
                        "unit": "잔",
                    }
                ]
            },
            message="하루 예상 주문량을 입력해 주세요. 공공데이터의 시간대 비중은 매장 주문량을 뜻하지 않습니다.",
        )
    return None


def _trace(
    body: CompareRequest,
    request_key: str,
    started: float,
    status: str,
    detail: str | None = None,
) -> None:
    if body.session_id is None:
        return  # 개발자 미리보기에는 저장할 work_session이 없으므로 FK 위반 방지
    write_tool_log(
        name="simulation",
        session_id=body.session_id,
        input_version_id=body.input_version_id,
        request_key=request_key,
        status=LOG_STATUS[status],
        latency_ms=int((time.perf_counter() - started) * 1000),
        payload={
            "response_status": status,
            "detail_status": detail,
            "repetitions": body.repetitions,
            "plan_count": 3,
        },
    )


@router.get("/options", response_model=ApiResponse[dict])
def get_options() -> ApiResponse[dict]:
    data = options()
    data["quality_targets"] = {
        "max_p90_post_order_receipt_sec": 300,
        "min_run_pass_rate": 0.8,
    }
    data["model_version"] = "operation.v1"
    return ok(data)


# Spring은 응답을 120초까지 기다린다(README). 하루 300건 × 30회가 개발 PC에서 약 84초였으므로 그 안으로 묶는다.
SPRING_MAX_ORDER_RUNS = 9000
# Spring이 같이 보내는 칸은 계산 조건으로 넘기지 않는다(근무표는 따로 해석, 요청 키는 헤더 값을 쓴다).
_NOT_FOR_ENGINE = {"plans", "choices", "staffing_schema_version", "request_key"}


def _needs_input(body, request_key, started, detail, message):
    _trace(body, request_key, started, "needs_input", detail)
    return needs_input(
        data={"missing_fields": [], "detail_status": detail}, message=message
    )


@router.post("/compare", response_model=ApiResponse[dict])
def compare_plans(
    body: CompareRequest, request_key: str = Depends(get_request_key)
) -> ApiResponse[dict]:
    """근무표(plans 또는 choices)가 오면 그 세 안을 그대로 시뮬레이션하고 Spring 계약(v0.4) 모양으로 돌려준다.
    근무표가 없으면 엔진이 정한 세 운영안으로 계산한다(개발·직접 호출용)."""
    started = time.perf_counter()
    missing = _validate_demand(body)
    if missing is not None:
        _trace(body, request_key, started, "needs_input", "MISSING_DAILY_ORDERS")
        return missing

    raw = body.model_dump(exclude_none=True)
    try:
        staffing = parse_staffing(raw)
        computed = compare(
            {k: v for k, v in raw.items() if k not in _NOT_FOR_ENGINE},
            engine="simpy",
            max_order_runs=SPRING_MAX_ORDER_RUNS,
            plan_rosters=staffing.rosters if staffing is not None else None,
        )
        data = to_contract(computed, staffing) if staffing is not None else computed
    except ContractError as exc:
        return _needs_input(
            body, request_key, started, "CONTRACT_INPUT_REQUIRED", str(exc)
        )
    except ValueError as exc:
        message = str(exc)
        if message.startswith("NEEDS_INPUT:"):
            detail = (
                "LIMIT_EXCEEDED" if "× 반복" in message else "STAFFING_INPUT_REQUIRED"
            )
            return _needs_input(
                body,
                request_key,
                started,
                detail,
                message.removeprefix("NEEDS_INPUT:").strip(),
            )
        _trace(body, request_key, started, "error", "INVALID_INPUT")
        raise HTTPException(
            status_code=400, detail=f"시뮬레이션 입력 오류: {message}"
        ) from exc
    except ImportError as exc:
        _trace(body, request_key, started, "error", "DEPENDENCY_MISSING")
        raise HTTPException(
            status_code=500, detail="SimPy 의존성이 설치되지 않았습니다."
        ) from exc

    data["request_key"] = request_key
    for key in ("session_id", "input_version_id", "result_id"):
        data[key] = getattr(body, key)
    data["trace_refs"] = []
    # 재생 기록(operation.trace.v2): include_events이고 Spring 결과 번호가 있을 때 안마다 1번째 반복을 남긴다.
    # 계약 모양으로 바꾸기 전 계산 결과(computed)에 사건이 들어 있다.
    if (
        body.session_id is not None
        and body.result_id is not None
        and body.include_events
    ):
        data["trace_refs"] = write_traces(
            computed,
            session_id=body.session_id,
            input_version_id=body.input_version_id,
            result_id=body.result_id,
            request_key=request_key,
        )
    _trace(body, request_key, started, "ok")
    return ok(data)


@router.post("/sensitivity", response_model=ApiResponse[dict])
def sensitivity_plans(
    body: SensitivityRequest, request_key: str = Depends(get_request_key)
) -> ApiResponse[dict]:
    started = time.perf_counter()
    if (
        body.plans is not None
        or body.choices is not None
        or body.staffing_schema_version is not None
    ):
        _trace(body, request_key, started, "error", "STAFFING_PLAN_UNSUPPORTED")
        raise HTTPException(
            status_code=400,
            detail="민감도 분석은 엔진이 정한 세 운영안으로만 계산합니다. 근무표 없이 보내 주세요.",
        )
    missing = _validate_demand(body)
    if missing is not None:
        _trace(body, request_key, started, "needs_input", "MISSING_DAILY_ORDERS")
        return missing
    try:
        result = sensitivity(
            body.model_dump(exclude_none=True, exclude=_NOT_FOR_ENGINE), engine="simpy"
        )
    except ValueError as exc:
        message = str(exc)
        if message.startswith("NEEDS_INPUT:"):
            _trace(body, request_key, started, "needs_input", "LIMIT_EXCEEDED")
            return needs_input(
                data={"missing_fields": [], "detail_status": "LIMIT_EXCEEDED"},
                message=message.removeprefix("NEEDS_INPUT:").strip(),
            )
        _trace(body, request_key, started, "error", "INVALID_INPUT")
        raise HTTPException(
            status_code=400, detail=f"민감도 입력 오류: {message}"
        ) from exc
    result["request_key"] = request_key
    _trace(body, request_key, started, "ok")
    return ok(result)
