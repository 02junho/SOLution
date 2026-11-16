"""입력을 해석하고 Spring이 저장할 스냅샷·질문을 돌려준다. 계산과 DB 입력 저장은 하지 않는다."""

from copy import deepcopy
from datetime import time
import math

from app.agent.interpreter import Interpreter
from app.agent.privacy import sanitize
from app.agent.schemas import Change, InterpretDraft, InterpretRequest, Unresolved
from app.core.response import ApiResponse, infeasible, needs_input
from app.core.status import ResponseStatus

_SCALARS = {
    "purchase": {"budget_krw", "max_delivery_count", "planning_days"},
    "operation": {"open_time", "close_time", "staff_count", "repeat_count"},
}
_ITEM_FIELDS = {"gross_need", "usable_inventory", "safety_stock", "storage_capacity", "max_end_inventory"}
_POSITIVE = {"planning_days", "max_delivery_count", "staff_count", "repeat_count", "storage_capacity"}
_INTEGERS = {"budget_krw", "planning_days", "max_delivery_count", "staff_count", "repeat_count"}


def use_form() -> ApiResponse[dict]:
    return needs_input({
        "detail_status": "USE_FORM",
        "missing_fields": [{"path": "form_input", "label": "폼 입력", "unit": None}],
    }, "지금은 말씀하신 내용을 해석하기 어려워요. 폼으로 입력해 주시겠어요?")


def _question(req: InterpretRequest, unresolved: Unresolved, *, path: str = "content", unit=None,
              draft_input: dict | None = None, evidence: list[str] | None = None) -> ApiResponse[dict]:
    previous = (req.question or {}).get("question")
    context = req.content if req.event_type == "message" else (
        previous.get("context") if isinstance(previous, dict) else None)
    data = {
        "detail_status": "NEEDS_INPUT",
        "missing_fields": [{"path": path, "label": unresolved.text, "unit": unit}],
        # 질문 ID 발급·유효성 검증은 Spring이 맡는다. opaque ID를 LLM이 만들지 않는다.
        "question": {"question_key": unresolved.question_key, "text": unresolved.text,
                     "choices": unresolved.choices, "base_version_id": req.current_version_id,
                     "context": context},
        "evidence": evidence or [],
    }
    if draft_input is not None:
        data["draft_input"] = draft_input
    return needs_input(data, unresolved.text)


def _valid_value(change: Change) -> bool:
    if change.target in {"open_time", "close_time"}:
        try:
            time.fromisoformat(str(change.value))
            return isinstance(change.value, str)
        except ValueError:
            return False
    value = change.value
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return False
    if value < 0 or (change.target in _POSITIVE and value == 0):
        return False
    return change.target not in _INTEGERS or value == int(value)


def run(req: InterpretRequest, interpreter: Interpreter) -> ApiResponse[dict]:
    if req.event_type == "message" and not (req.content and req.content.strip()):
        raise ValueError("content가 필요합니다.")
    if req.event_type == "question_reply" and (
        not req.question_id or not req.question_id.strip() or req.answer is None
        or isinstance(req.answer, str) and not req.answer.strip()
    ):
        raise ValueError("question_id와 answer가 필요합니다.")

    req = InterpretRequest.model_validate(sanitize(req.model_dump()))
    draft = InterpretDraft.model_validate(sanitize(interpreter.interpret(req).model_dump()))
    if draft.intent == "unsupported":
        return infeasible({"detail_status": "UNSUPPORTED", "evidence": draft.evidence},
                          draft.reply or "이번 서비스에서는 처리할 수 없는 요청이에요.")
    if draft.unresolved:
        return _question(req, draft.unresolved[0], evidence=draft.evidence)
    if draft.changes and draft.intent != "change_input":
        return _question(req, Unresolved(question_key="content", text="변경하려는 입력을 다시 확인해 주세요."))

    original = deepcopy(req.current_input or {})
    candidate = deepcopy(original)
    if req.event_type == "question_reply" and req.question:
        question = req.question
        if (question.get("base_version_id") == req.current_version_id
                and isinstance(question.get("draft_input"), dict)):
            candidate = deepcopy(question["draft_input"])

    seen: dict[tuple, object] = {}
    for change in draft.changes:
        target = change.target
        if target not in _SCALARS[req.feature_type] and not (
            req.feature_type == "purchase" and target in _ITEM_FIELDS
        ):
            return _question(req, Unresolved(question_key=f"{change.field}_target",
                text=f"'{change.label}'을(를) 어느 값으로 바꿀까요?", choices=[]),
                evidence=draft.evidence)
        if not _valid_value(change):
            return _question(req, Unresolved(question_key=target, text=f"'{change.label}'의 유효한 값을 알려 주세요."),
                             path=target, unit=change.unit, evidence=draft.evidence)
        identity = (target, None if target in _SCALARS[req.feature_type] else change.item_id)
        if identity in seen and seen[identity] != change.value:
            return _question(req, Unresolved(question_key=target, text=f"'{change.label}'의 값을 하나로 정해 주세요."),
                             path=target, unit=change.unit, evidence=draft.evidence)
        seen[identity] = change.value
        if target in _SCALARS[req.feature_type]:
            # 운영 설정은 운영 담당 어댑터가 제공한 기존 키만 바꾼다.
            if req.feature_type == "operation" and target not in original:
                return _question(req, Unresolved(question_key=target, text="현재 운영 설정을 먼저 입력해 주세요."), path=target)
            if target == "staff_count" and (isinstance(original[target], bool) or not isinstance(original[target], int)):
                return _question(req, Unresolved(question_key=target, text="현재 인원 수를 확인해 주세요."), path=target)
            if target == "staff_count" and change.value not in {original[target], original[target] + 1}:
                return infeasible({"detail_status": "UNSUPPORTED", "suggestions": ["현재 인원 또는 1명 추가 후보를 선택해 주세요."]},
                                  "지원하는 운영 후보 범위 밖이에요.")
            candidate[target] = int(change.value) if target in _INTEGERS else change.value
            continue

        items = candidate.get("items")
        if not isinstance(items, list):
            items = []
        matches = [(index, item) for index, item in enumerate(items)
                   if isinstance(item, dict) and change.item_id is not None and item.get("item_id") == change.item_id]
        if len(matches) != 1:
            return _question(req, Unresolved(question_key=f"{change.field}_item", text="어느 품목을 바꿀지 알려 주세요."),
                             path="items", evidence=draft.evidence)
        index, item = matches[0]
        unit = item.get("base_unit")
        if unit not in {"g", "ml", "ea"} or unit != change.unit:
            return _question(req, Unresolved(question_key=f"{change.field}_unit", text="입력 단위를 확인해 주세요."),
                             path=f"items[{index}].{target}", unit=unit)
        item[target] = change.value

    # 같은 이벤트에서 안전재고와 상한을 함께 바꿀 수 있으므로 전체 변경 후 검사한다.
    candidate_items = candidate.get("items")
    for index, item in enumerate(candidate_items if isinstance(candidate_items, list) else []):
        if not isinstance(item, dict):
            continue
        maximum, safety = item.get("max_end_inventory"), item.get("safety_stock")
        if isinstance(maximum, (int, float)) and isinstance(safety, (int, float)) and maximum < safety:
            return _question(req, Unresolved(question_key="max_end_inventory", text="기간 끝 재고 한도는 안전재고 이상이어야 해요."),
                             path=f"items[{index}].max_end_inventory", unit=item.get("base_unit"))

    if req.feature_type == "operation" and candidate.get("open_time") and candidate.get("close_time"):
        try:
            if time.fromisoformat(candidate["open_time"]) >= time.fromisoformat(candidate["close_time"]):
                return _question(req, Unresolved(question_key="close_time", text="마감 시간을 개점 시간 뒤로 입력해 주세요."), path="close_time")
        except (TypeError, ValueError):
            return _question(req, Unresolved(question_key="open_time", text="운영 시간을 확인해 주세요."), path="open_time")

    if not draft.changes and draft.intent != "smalltalk":
        return _question(req, Unresolved(question_key="content", text=draft.reply or "무엇을 바꿀지 알려 주세요."))
    if candidate == original:
        return ApiResponse(status=ResponseStatus.OK,
                           data={"detail_status": "NO_CHANGE", "interpretation": {"intent": draft.intent, "changes": []}},
                           message=draft.reply or "입력은 바꾸지 않았어요.")
    return ApiResponse(status=ResponseStatus.OK, data={
        "detail_status": "INTERPRETED",
        "interpretation": {"intent": "change_input", "changes": [c.model_dump() for c in draft.changes],
                           "evidence": draft.evidence},
        "parsed_input": {"source": req.event_type, "changes": [c.model_dump() for c in draft.changes], "input": candidate},
        "assumptions": [], "warnings": [],
    }, message=draft.reply or "입력 변경을 반영했어요. 확인해 주세요.")
