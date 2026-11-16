"""사장님의 말을 구조화 해석으로 바꾸는 부분(HW-F02). LLM이 '해석'을 맡는다.

설계(명세 11): 1차 LangGraph 미사용, 일반 Python 분기. LLM에는 전체 DTO가 아니라 작은 요약만 준다.
JSON 형식이 깨지면 1회만 형식 보정을 다시 시킨다(H05). 그래도 안 되면 '되묻기(ask)'로 안전하게 넘긴다.

모델은 한 곳(app/core/config.py)에서만 정한다(현재 claude-sonnet-5-5). 키가 없으면 가짜 성공을 만들지 않고
LlmUnavailable을 올려 폼 입력으로 안내한다. 토큰·비용·개인정보는 기록하지 않는다.
"""

from __future__ import annotations

import json
import logging
from typing import Protocol

from app.agent.schemas import InterpretDraft, InterpretRequest, Unresolved
from app.agent.privacy import sanitize
from app.core.config import get_settings

logger = logging.getLogger(__name__)


class LlmUnavailable(RuntimeError):
    """실패·거절 원문을 응답에 싣지 않고 폼 입력 안내로 전환한다."""

    def __init__(self, message: str, *, retryable: bool = False, refused: bool = False):
        super().__init__(message)
        self.retryable = retryable
        self.refused = refused


class Interpreter(Protocol):
    """해석기 공통 약속. 실제 LLM 해석기와 테스트용 가짜 해석기가 이 모양을 지킨다."""

    def interpret(self, req: InterpretRequest) -> InterpretDraft: ...


# ===== LLM에게 주는 지시문 =====
# 매장 사실을 지어내지 말고, 애매하면 unresolved로 되묻게 한다(서버가 임의로 0/재고를 고르지 않음).
_SYSTEM = (
    "너는 소상공인 카페 사장님의 '매입/운영 준비' 업무를 돕는 해석기다. "
    "사장님의 한국어 입력을 읽고, 바꾸려는 값만 구조화해서 JSON으로만 답한다. 설명 문장은 넣지 않는다.\n"
    "규칙:\n"
    "1) 매장 사실(재고·예산 등)을 모르면 지어내지 말고 unresolved에 질문으로 넣는다.\n"
    "2) '우유 2L로 바꿔줘'처럼 그 값이 '지금 재고'인지 '이번에 필요한 총량'인지 애매하면 "
    "changes에 넣지 말고 unresolved로 되묻는다(target을 임의로 고르지 않는다).\n"
    "3) 수량 단위는 g/ml/ea(개), 금액은 원. 2L는 2000ml로 환산해도 되지만 어느 칸인지 모르면 역시 되묻는다.\n"
    "4) 실제 발주·결제·문자 전송 같은 요청은 intent=unsupported로 둔다.\n"
    "5) 모르는 값은 0이 아니라 비워 둔다. 품목 변경은 입력에 있는 item_id를 명시한다.\n"
    "JSON 스키마: {intent: change_input|ask|unsupported|smalltalk, "
    "changes:[{field,label,value,unit,target,item_id}], unresolved:[{question_key,text,choices}], "
    "evidence:[string], reply:string}"
)


class LlmInterpreter:
    """langchain-anthropic로 실제 모델을 부르는 해석기. 라이브러리는 필요할 때 늦게 불러온다."""

    def interpret(self, req: InterpretRequest) -> InterpretDraft:
        settings = get_settings()
        self.call_count = 0
        if not settings.anthropic_api_key:
            raise LlmUnavailable("LLM API 키가 설정되지 않았습니다.")

        prompt = _build_user_prompt(req)
        repairs = failures = 0
        # 최초 호출 + 전송 실패 재시도 2회 + 형식 보정 1회, 총 4회 이내(80초 이내).
        while self.call_count < 4:
            self.call_count += 1
            try:
                raw = self._call(settings, _SYSTEM, prompt)
            except LlmUnavailable as exc:
                if exc.retryable and not exc.refused and failures < 2:
                    failures += 1
                    continue
                raise
            draft = _parse(raw)
            if draft is not None:
                return draft
            if repairs == 1:
                break
            repairs += 1
            prompt += "\n지난 답의 형식이 잘못되었다. 위 스키마의 JSON만 다시 출력하라."

        logger.warning("LLM 응답 형식 보정 한도에 도달했습니다.")
        return InterpretDraft(intent="ask", unresolved=[Unresolved(
            question_key="content", text="무엇을 바꿀지 조금 더 자세히 알려 주세요.")])

    def _call(self, settings, system: str, user: str) -> str:
        try:
            from langchain_anthropic import ChatAnthropic
            from anthropic import APIConnectionError
        except ImportError as exc:  # pragma: no cover - 환경 문제
            raise LlmUnavailable("langchain-anthropic가 설치되지 않았습니다.") from exc
        try:
            model = ChatAnthropic(
                model=settings.anthropic_model,
                api_key=settings.anthropic_api_key,
                max_retries=0,       # SDK 재시도를 끄고 위의 전체 호출 상한만 적용한다.
                max_tokens=1024,
                timeout=20,
            )
            result = model.invoke([("system", system), ("human", user)])
        except Exception as exc:
            status = getattr(exc, "status_code", None)
            retryable = isinstance(exc, (APIConnectionError, TimeoutError, ConnectionError)) or status == 429 or (
                isinstance(status, int) and status >= 500)
            raise LlmUnavailable("LLM 호출에 실패했습니다.", retryable=retryable) from exc
        if result.response_metadata.get("stop_reason") == "refusal":
            raise LlmUnavailable("LLM이 요청을 거절했습니다.", refused=True)
        content = result.content
        if isinstance(content, list):  # langchain이 블록 배열로 줄 때는 텍스트만 모은다.
            content = "".join(part["text"] for part in content
                              if isinstance(part, dict) and isinstance(part.get("text"), str))
        return str(content)


def _build_user_prompt(req: InterpretRequest) -> str:
    """LLM에 줄 입력. 전체 DTO가 아니라 해석에 필요한 작은 요약만 담는다."""
    req = InterpretRequest.model_validate(sanitize(req.model_dump()))
    lines = [f"업무 종류: {'매입' if req.feature_type == 'purchase' else '운영'}"]
    if req.current_input:
        # 큰 입력은 잘라서 요약만 전달한다.
        summary = json.dumps(req.current_input, ensure_ascii=False)
        if len(summary) > 1500:
            summary = summary[:1500] + "…(생략)"
        lines.append(f"지금까지의 입력(요약): {summary}")
    if req.event_type == "message":
        lines.append(f"사장님 말: {req.content or ''}")
    else:
        lines.append(f"서버가 한 질문(id): {req.question_id}")
        lines.append(f"질문 내용·선택지: {json.dumps(req.question, ensure_ascii=False)[:1500]}")
        lines.append(f"사장님 답: {req.answer}")
        lines.append("이 답으로 앞의 질문을 풀어 changes를 완성하라. 여전히 애매하면 unresolved로 둔다.")
    return "\n".join(lines)


def _parse(raw: str) -> InterpretDraft | None:
    """모델이 코드블록이나 군더더기를 붙여도 가운데 JSON만 떼어 읽는다. 실패하면 None."""
    if not raw:
        return None
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start : end + 1])
        return InterpretDraft.model_validate(data)
    except (json.JSONDecodeError, ValueError):
        return None


def get_interpreter() -> Interpreter:
    """FastAPI 의존성. 기본은 실제 LLM 해석기. 테스트는 이 함수를 가짜로 바꿔 끼운다."""
    return LlmInterpreter()
