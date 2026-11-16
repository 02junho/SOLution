"""POST /agent/interpret 요청·응답 모양.

이 주소는 화면이 직접 부르지 않는다. Spring(WorkSessionEventService)이 사장님의 말/질문답변을
검증된 DTO로 넘겨 부른다. LLM이 해석한 결과를 공통 응답(ApiResponse) 형식으로 돌려준다.

Spring 연결 계약: ok에는 parsed_input.input 전체 입력 스냅샷, needs_input에는 missing_fields를 포함한다.
질문 ID와 입력 버전 저장은 Spring이 맡는다. 지원하지 않는 변경은 임의로 적용하지 않고 질문한다.
"""

from decimal import Decimal
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

# 수량 단위. 모르는 값은 null로 둔다(0으로 바꾸지 않는다).
BaseUnit = Literal["g", "ml", "ea"]


class InterpretRequest(BaseModel):
    """Spring이 넘기는 한 번의 입력. event_type에 따라 content 또는 question_id+answer가 온다."""

    store_id: int
    session_id: int
    feature_type: Literal["purchase", "operation"]
    event_type: Literal["message", "question_reply"]
    # 사용자가 보고 있던 기준 입력 버전. 늦게 도착한 답이 최신을 덮지 않도록 검사에 쓴다(H04).
    base_version_id: int | None = None
    current_version_id: int | None = None
    # 지금까지 확정된 입력(요약). 전체를 모델에 통째로 넘기지 않고, 해석에 필요한 작은 요약만 쓴다.
    current_input: dict[str, Any] | None = None
    # event_type == "message"일 때
    content: str | None = None
    # event_type == "question_reply"일 때 (서버가 발급한 질문 id와 사장님의 답)
    question_id: str | None = None
    answer: Any | None = None
    # Spring이 발급·검증한 질문의 누락 필드·선택지·입력 초안.
    question: dict[str, Any] | None = None


class Change(BaseModel):
    """사장님이 바꾸려는 값 후보. '검증 전'이며 아직 DB 입력이 아니다(HW-F02)."""

    model_config = ConfigDict(allow_inf_nan=False)

    item_id: str | None = None
    field: str                      # 예: "budget_krw", "milk_quantity"
    label: str                      # 사람이 읽는 이름. 예: "예산", "우유 수량"
    value: float | int | str | None = None
    unit: BaseUnit | None = None
    # 어느 칸을 바꾸는지. 애매하면 "unknown" → 서버가 임의로 고르지 않고 질문으로 돌린다.
    target: str = "unknown"


    @field_validator("value", mode="before")
    @classmethod
    def reject_boolean(cls, value):
        if isinstance(value, bool):
            raise ValueError("변경 수치에 참/거짓은 사용할 수 없습니다.")
        return value


class Unresolved(BaseModel):
    """해석이 애매해서 사장님께 물어야 하는 것. 서버가 질문을 발급한다(HW-F04)."""

    question_key: str               # 질문 종류 식별용. 예: "milk_quantity_target"
    text: str                       # 사장님에게 보일 질문 문장
    choices: list[str] = Field(default_factory=list)  # 선택지(있으면). 없으면 자유 입력


class InterpretDraft(BaseModel):
    """LLM(또는 가짜 해석기)이 돌려주는 1차 해석 결과. 서비스가 이걸 공통 응답으로 바꾼다."""

    # change_input=값 바꾸기 / ask=되묻기 / unsupported=이번 범위 밖 / smalltalk=잡담·변경 없음
    intent: Literal["change_input", "ask", "unsupported", "smalltalk"] = "ask"
    changes: list[Change] = Field(default_factory=list)
    unresolved: list[Unresolved] = Field(default_factory=list)
    evidence: list[str] = Field(default_factory=list)   # 그렇게 해석한 근거(사장님 원문 조각 등)
    reply: str = ""                                     # 사장님에게 보일 한 줄 설명


class ExplainRequest(BaseModel):
    """Spring이 저장된 결과에서 추린 작은 요약. 설명 생성 중 계산·결과 저장은 하지 않는다."""

    store_id: int
    session_id: int
    feature_type: Literal["purchase", "operation"]
    result_id: int
    result_summary: dict[str, Any] = Field(min_length=1)
    focus: str | None = None


    @field_validator("result_summary")
    @classmethod
    def validate_summary(cls, summary):
        choices = summary.get("choices", [])
        if not isinstance(choices, list):
            raise ValueError("choices는 목록이어야 합니다.")
        keys = set()
        for choice in choices:
            if not isinstance(choice, dict) or not isinstance(choice.get("choice_key"), str) or not choice["choice_key"].strip():
                raise ValueError("각 안에는 choice_key가 필요합니다.")
            if choice["choice_key"] in keys:
                raise ValueError("choice_key는 중복될 수 없습니다.")
            keys.add(choice["choice_key"])
            if choice.get("label") is not None and not isinstance(choice["label"], str):
                raise ValueError("안 이름은 문자열이어야 합니다.")
            for field in ("total_krw", "delivery_count"):
                value = choice.get(field)
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))
                        or not Decimal(str(value)).is_finite() or value < 0 or Decimal(str(value)) != Decimal(str(value)).to_integral_value()):
                    raise ValueError(f"{field}는 0 이상의 정수여야 합니다.")
        warnings = summary.get("warnings", [])
        if not isinstance(warnings, list) or any(not isinstance(w, dict) for w in warnings):
            raise ValueError("warnings는 경고 객체의 목록이어야 합니다.")
        if any("requires_ack" in w and not isinstance(w["requires_ack"], bool) for w in warnings):
            raise ValueError("requires_ack는 참/거짓이어야 합니다.")
        assumptions = summary.get("assumptions", [])
        if not isinstance(assumptions, list) or any(not isinstance(a, str) for a in assumptions):
            raise ValueError("assumptions는 문자열 목록이어야 합니다.")
        return summary


class ChoiceExplanation(BaseModel):
    """LLM이 말투만 다듬는 안별 설명. 수치·단위 검증은 서비스가 별도로 수행한다."""

    choice_key: str
    text: str


class ExplainDraft(BaseModel):
    headline: str
    per_choice: list[ChoiceExplanation]
    caveats: list[str] = Field(default_factory=list)
