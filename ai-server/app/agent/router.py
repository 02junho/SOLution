"""POST /agent/interpret — 사장님의 말/질문답변을 해석한다(분류·입력 추출·검사·질문).

- 애매하면 needs_input으로 서버가 질문을 발급한다(임의로 매장 사실을 고르지 않음).
- 바꿀 값이 분명하면 ok로 '검토 후보'를 돌려준다(저장은 Spring 몫).
- 실제 발주·결제 등 범위 밖은 infeasible.
- 화면은 이 주소를 직접 부르지 않는다. Spring이 AiServerClient로 부른다.
- 결과 설명(/agent/explain)은 결과 생성 기능과 함께 다음 단계에서 붙인다.
"""

import time

from fastapi import APIRouter, Depends, HTTPException

from app.agent import explain_service
from app.agent.explain_service import Explainer, get_explainer
from app.agent.interpreter import Interpreter, LlmUnavailable, get_interpreter
from app.agent.schemas import ExplainRequest, InterpretRequest
from app.agent.service import run, use_form
from app.core.execution_log import LOG_STATUS, write_tool_log
from app.core.request_key import get_request_key
from app.core.response import ApiResponse

router = APIRouter()


@router.post("/interpret")
def interpret(
    body: InterpretRequest,
    request_key: str = Depends(get_request_key),
    interpreter: Interpreter = Depends(get_interpreter),
) -> ApiResponse[dict]:
    started = time.perf_counter()
    try:
        result = run(body, interpreter)
    except ValueError as exc:  # 필수값 누락 등 → 400
        _log(body, request_key, "failed", started, {"response_status": "error"})
        raise HTTPException(status_code=400, detail=f"요청 값이 올바르지 않습니다. {exc}") from exc
    except LlmUnavailable as exc:
        result = use_form()
        _log(body, request_key, "refused" if exc.refused else "failed", started,
             {"response_status": "needs_input", "detail_status": "USE_FORM"})
        return result

    data = result.data or {}
    _log(body, request_key, LOG_STATUS[result.status.value], started, {
        "response_status": result.status.value,
        "detail_status": data.get("detail_status"),
        "event_type": body.event_type,
    })
    return result


def _log(body: InterpretRequest, request_key: str, status: str, started: float, payload: dict) -> None:
    write_tool_log(
        name="agent.interpret",
        log_type="llm",
        session_id=body.session_id,
        input_version_id=body.current_version_id,
        request_key=request_key,
        status=status,
        latency_ms=int((time.perf_counter() - started) * 1000),
        payload=payload,
    )


@router.post("/explain")
def explain(
    body: ExplainRequest,
    request_key: str = Depends(get_request_key),
    explainer: Explainer = Depends(get_explainer),
) -> ApiResponse[dict]:
    started = time.perf_counter()
    try:
        result = explain_service.run(body, explainer)
    except ValueError as exc:  # result_summary 누락 등 → 400
        _log_explain(body, request_key, "failed", started, {"response_status": "error"})
        raise HTTPException(status_code=400, detail=f"요청 값이 올바르지 않습니다. {exc}") from exc

    data = result.data or {}
    _log_explain(body, request_key, LOG_STATUS[result.status.value], started, {
        "response_status": result.status.value,
        "detail_status": data.get("detail_status"),
        "source": data.get("source"),
    })
    return result


def _log_explain(body: ExplainRequest, request_key: str, status: str, started: float, payload: dict) -> None:
    write_tool_log(
        name="agent.explain",
        log_type="llm",
        result_id=body.result_id,
        session_id=body.session_id,
        input_version_id=None,  # 설명은 특정 입력 버전이 아니라 결과(result_id) 기준이다.
        request_key=request_key,
        status=status,
        latency_ms=int((time.perf_counter() - started) * 1000),
        payload=payload,
    )
