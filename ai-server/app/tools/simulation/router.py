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
from .day_window import from_scenario, using
from .daily_roster import plan as daily_roster
from .weekly_roster import plan as weekly_roster
from .week_plan import plan as week_plan
from .menu_types import classify as classify_menus
from .roster_chat import chat as roster_chat, explain as roster_explain
from .roster_options import plan as roster_options
from .roster_replay import replay as roster_replay

# 근무표 계산(하루·일주일·추천 3안)은 같은 이벤트를 같은 순서로 처리하는 가벼운 스케줄러로 돌린다.
# SimPy와 결과가 숫자 하나까지 같고(tests/test_roster_engine.py), 이벤트마다 SimPy 프로세스를 만들지 않아 약 30% 빠르다.
# 세 운영안 비교·민감도(운영 1번)는 그대로 SimPy.
ROSTER_ENGINE = "reference"
from app.schemas.simulation import DailyRosterRequest, RosterOptionsRequest, WeekPlanRequest, WeeklyRosterRequest

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
        # 받은 근무표도 같은 영업시간(scenario.start_time·end_time) 기준으로 구간을 나눈다.
        with using(from_scenario(raw.get("scenario"))):
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


@router.post("/daily-roster", response_model=ApiResponse[dict])
def daily_roster_plan(
    body: DailyRosterRequest, request_key: str = Depends(get_request_key)
) -> ApiResponse[dict]:
    """하루 근무표 자동 생성: 시간대별 필요 인원 → 근무조로 덮기 → 휴게 → 휴게까지 넣어 다시 확인. 저장하지 않는다."""
    started = time.perf_counter()
    missing = _validate_demand(body)
    if missing is not None:
        _trace(body, request_key, started, "needs_input", "MISSING_DAILY_ORDERS")
        return missing
    raw = body.model_dump(exclude_none=True)
    if raw.get("roster_rules") == {}:
        raw.pop("roster_rules")
    try:
        data = daily_roster(
            {k: v for k, v in raw.items() if k not in _NOT_FOR_ENGINE}, engine=ROSTER_ENGINE
        )
    except ValueError as exc:
        message = str(exc)
        if message.startswith("NEEDS_INPUT:"):
            return _needs_input(
                body, request_key, started, "ROSTER_INPUT_REQUIRED",
                message.removeprefix("NEEDS_INPUT:").strip(),
            )
        _trace(body, request_key, started, "error", "INVALID_INPUT")
        raise HTTPException(status_code=400, detail=f"근무표 입력 오류: {message}") from exc
    data["request_key"] = request_key
    _trace(body, request_key, started, "ok")
    return ok(data)


@router.post("/weekly-roster", response_model=ApiResponse[dict])
def weekly_roster_plan(
    body: WeeklyRosterRequest, request_key: str = Depends(get_request_key)
) -> ApiResponse[dict]:
    """일주일 근무표: 요일별 근무조를 명단에 배정하고 주 15시간 미만 / 주휴 포함을 비교한다. 저장하지 않는다."""
    try:
        data = weekly_roster(body.model_dump(exclude_none=True))
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"일주일 근무표 입력 오류: {exc}") from exc
    data["request_key"] = request_key
    return ok(data)


@router.post("/week-plan", response_model=ApiResponse[dict])
def week_plan_run(body: WeekPlanRequest, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    """일주일 근무표 한 번에: 요일별 필요 인원 → 두 가지 근무조(주휴 포함 / 15시간 미만) → 명단 배정. 저장하지 않는다."""
    raw = body.model_dump(exclude_none=True)
    days = []
    for d in raw["days"]:
        roster = {k: v for k, v in d["roster"].items() if k not in _NOT_FOR_ENGINE}
        if roster.get("roster_rules") == {}:
            roster.pop("roster_rules")
        days.append({"day": d["day"], "roster": roster})
    try:
        data = week_plan({"days": days, "workers": raw["workers"], "weekly_mode": raw["weekly_mode"]}, engine=ROSTER_ENGINE)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"일주일 근무표 입력 오류: {exc}") from exc
    data["request_key"] = request_key
    return ok(data)


def _engine_days(raw_days):
    days = []
    for d in raw_days:
        roster = {k: v for k, v in d["roster"].items() if k not in _NOT_FOR_ENGINE}
        if roster.get("roster_rules") == {}:
            roster.pop("roster_rules")
        days.append({"day": d["day"], "roster": roster})
    return days


@router.post("/roster-options", response_model=ApiResponse[dict])
def roster_options_run(body: RosterOptionsRequest, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    """추천 근무표 3안: 요일별 꼭 필요한 인원 → 바쁜 시간에만 0~3명 더해 비교 → 아끼는/추천/여유 안(주 15시간 미만). 저장하지 않는다."""
    raw = body.model_dump(exclude_none=True)
    request = {"days": _engine_days(raw["days"]), "workers": raw["workers"]}
    for key in ("min_gain_sec", "compare_holiday_pay", "background"):
        if key in raw:
            request[key] = raw[key]
    try:
        data = roster_options(request, engine=ROSTER_ENGINE)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"추천 근무표 입력 오류: {exc}") from exc
    data["request_key"] = request_key
    return ok(data)


@router.post("/roster-replay", response_model=ApiResponse[dict])
def roster_replay_run(body: dict, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    """저장한 추천 근무표의 하루를 한 번 다시 돌려 줄 서는 모습 기록(operation.trace.v2)을 만든다. 저장하지 않는다."""
    roster = body.get("roster")
    if isinstance(roster, dict):
        roster = {k: v for k, v in roster.items() if k not in _NOT_FOR_ENGINE}
        if roster.get("roster_rules") == {}:
            roster.pop("roster_rules")
    try:
        data = roster_replay({**body, "roster": roster}, engine=ROSTER_ENGINE)
    except (ValueError, KeyError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"줄 서는 모습 입력 오류: {exc}") from exc
    data["request_key"] = request_key
    return ok(data)


@router.post("/roster-chat", response_model=ApiResponse[dict])
def roster_chat_run(body: dict, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    """말로 고치기: 사장님 말 → 바꿀 칸(허용 목록 안, 코드가 범위 검사) / 결과 질문 답 / 다시 계산. 키가 없으면 source=UNAVAILABLE."""
    try:
        data = roster_chat(body)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"말로 고치기 입력 오류: {exc}") from exc
    data["request_key"] = request_key
    return ok(data)


@router.post("/roster-explain", response_model=ApiResponse[dict])
def roster_explain_run(body: dict, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    """추천 근무표 결과 설명(두세 문장). 결과에 없는 숫자가 있으면 화면이 보낸 코드 문장(fallback)을 쓴다."""
    try:
        data = roster_explain(body)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"결과 설명 입력 오류: {exc}") from exc
    data["request_key"] = request_key
    return ok(data)


@router.post("/menu-types", response_model=ApiResponse[dict])
def menu_types(body: dict, request_key: str = Depends(get_request_key)) -> ApiResponse[dict]:
    """낱말 규칙으로 모른 메뉴 이름만 받아 제조 유형을 고른다. 키가 없거나 실패하면 모두 null(source=UNAVAILABLE)."""
    try:
        data = classify_menus(body)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=400, detail=f"메뉴 유형 입력 오류: {exc}") from exc
    data["request_key"] = request_key
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
