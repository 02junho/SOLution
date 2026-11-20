"""운영 실험 대화 해석 흐름. 공통 해석(service.run)은 운영이면 handle()로 넘기고, 이 파일만 운영 규칙을 안다.

- 저장 입력은 폼 값만({"operation_form": {...}}). 근무표 세 안은 계산할 때 Spring이 만든다.
- 처음 입력: 사장님이 자유롭게 말한 값을 저장하고, 빠진 필수 값(하루 주문 → 사장님 근무 → 직원 시급)만 말풍선으로 묻는다.
  방금 물은 칸을 LLM 요약(prompt_summary)에 넣어, 짧은 답도 LLM이 그 질문의 답으로 읽는다(키워드 규칙 없음).
- 수정: 저장된 폼 값을 바꾼다. 말하지 않은 선택 칸은 비워 두고 계산할 때 기본값을 쓴다.
- 계산 시작("비교해줘" 등): LLM이 운영 규칙(PROMPT_RULE)에 따라 실행 표시(target=run_comparison)를 돌려주면
  화면에 계산 시작 표시(action: run_operation)를 보낸다. 잡담으로 분류돼도 실행 표시를 먼저 본다.
- 바꿀 값이 없는 말(설명 질문 등): 질문 카드 없이 AI 답 또는 계산 버튼 안내로 답한다.
공통 파일은 바꾸지 않는다: 공통 해석기가 열어 둔 prompt_rule·prompt_summary·handle 연결 지점만 쓴다.
칸 목록·검사는 operation_fields.py에 있다.
"""

import json
from copy import deepcopy

from app.agent import operation_fields
from app.agent.schemas import Change, InterpretDraft, InterpretRequest
from app.core.response import ApiResponse, infeasible, needs_input
from app.core.status import ResponseStatus

# LLM이 "계산을 시작해 달라"는 말에 돌려주는 실행 표시(폼 칸이 아니다).
RUN = "run_comparison"

# 해석기(LLM) 지시문에 붙이는 운영 규칙.
PROMPT_RULE = (
    "운영 업무 규칙: target은 daily_orders(하루 주문 건수), last_order_time(라스트 오더, HH:MM 24시간), "
    "is_owner_working(사장님이 매장에서 일하면 1, 안 하면 0), hourly_wage_krw(직원 시급, 원), "
    "order_time_sec(주문·결제 평균 초), handoff_time_sec(음료 전달 평균 초). unit은 null이다. "
    "오후 시각은 24시간으로 바꾼다(라스트오더 7시 → 19:00). "
    "'50건 늘려'처럼 상대적인 말은 요약의 지금 값에 더한 결과를 value로 쓴다. "
    "요약의 '화면 표기'는 칸 값이 화면에 보이는 모양이다. 사장님이 그 표기나 같은 뜻으로 말하면 그 칸의 값으로 넣고, "
    "다른 칸(staff_count 등)으로 보지 않는다. 화면 표기로 설명되지 않는 인원 변경만 staff_count다. 영업 시간은 "
    "open_time/close_time, 바쁜 시간은 rush_start_time/rush_end_time으로 target을 적되 값은 바꾸지 않는다"
    "(서버가 안내한다). "
    "질문에 답하는 경우 질문 context의 사장님 말에 있던 값도 changes에 모두 다시 넣는다. "
    "비교하는 세 안: 현재 방식(주문·전달 1명과 제조 1명이 각자 맡은 일만), 서로 돕기(같은 사람·시간, 바쁜 시간에만 "
    "주문·제조를 서로 도움), 한 명 추가(바쁜 시간에 제조를 맡고 주문도 돕는 직원 1명을 더함). 바쁜 시간은 상권 "
    "데이터에서 손님이 가장 몰리는 11~14시다. 세 안이나 결과 용어를 "
    "물으면 intent=ask로 두고 reply에 쉬운 말로 짧게 설명한다. "
    "요약에 '방금 물은 칸'이 있으면 사장님 말이 그 질문의 답인지 먼저 본다. '네', '응', '아니요', '최저' 같은 짧은 답도 "
    "그 target의 값으로 changes에 넣는다(사장님 근무 질문에 '네' → is_owner_working=1, '직원끼리 해요' → 0, "
    "시급 질문에 '최저' → 요약의 최저시급 값, '최저 말고 11000원' → 11000). 질문과 상관없는 말이면 그 말대로 해석하고, "
    "답인지 애매하면 changes에 넣지 말고 intent=ask로 reply에 다시 묻는다. "
    f"세 운영안 계산(비교)을 지금 시작해 달라는 말이면('비교해줘', '돌려 봐', '실행해줘') changes에 target={RUN}, "
    "value=1 하나만 넣는다. 하지 말라는 말('아직 돌리지 마')이나 질문('비교하면 뭐가 나아?')이면 넣지 않는다.\n"
)


def prompt_rule(req: InterpretRequest) -> str:
    """해석기 지시문에 붙일 운영 규칙. 운영 요청이 아니면 빈 문자열(다른 업무 지시문은 그대로)."""
    return PROMPT_RULE if req.feature_type == "operation" else ""


_NO_CHANGE_GUIDE = (
    "조건은 그대로예요. 계산은 아래 '세 운영안 비교하기' 버튼으로 시작해요. "
    "값을 바꾸려면 '하루 200건', '라스트오더 7시'처럼 말씀해 주세요."
)


def prompt_summary(req: InterpretRequest) -> str | None:
    """LLM에 줄 운영 입력 요약. 필수 값이 다 있으면 바꿀 수 있는 지금 값, 채우는 중이면 채운 값만. 운영이 아니면 None."""
    if req.feature_type != "operation":
        return None
    values = operation_fields.form_values(req.current_input)
    labels = {"화면 표기": operation_fields.VALUE_LABELS}
    if operation_fields.is_complete(values):
        return json.dumps(
            {**operation_fields.summary(req.current_input), **labels}, ensure_ascii=False
        )
    # 채우는 중: 채운 값과 방금 물은 칸(짧은 답을 그 질문의 답으로 읽게).
    return json.dumps(
        {"작성 중": values, "방금 물은 칸": operation_fields.pending_question(values), **labels},
        ensure_ascii=False,
    )


def handle(req: InterpretRequest, draft: InterpretDraft) -> ApiResponse[dict] | None:
    """운영 해석. 잡담·처리 불가는 공통 흐름에 맡긴다(None)."""
    current = deepcopy(req.current_input or {})
    values = operation_fields.form_values(current)
    complete = operation_fields.is_complete(values)
    # 실행 표시는 의도 분류(잡담 등)와 상관없이 먼저 본다. 다른 값과 섞여 오면 값 바꾸기만 한다.
    wants_run = any(c.target == RUN for c in draft.changes)
    changes = [c for c in draft.changes if c.target != RUN]
    draft = draft.model_copy(update={"changes": changes})
    if wants_run and changes:
        wants_run = False
    if draft.intent in {"smalltalk", "unsupported"} and not changes and not wants_run:
        if complete:
            return None
        # 채우는 중 잡담: AI 답 뒤에 묻던 값을 다시 묻는다.
        missing = operation_fields.next_missing(values)
        ask = f"{missing[2]} ({missing[0]}/{len(operation_fields.GUIDED)})" if missing else ""
        return ApiResponse(
            status=ResponseStatus.OK,
            data={
                "detail_status": "NO_CHANGE",
                "interpretation": {"intent": draft.intent, "changes": []},
            },
            message=" ".join(part for part in (draft.reply, ask) if part),
        )
    if changes or not complete:
        if wants_run and not complete:
            missing = operation_fields.next_missing(values)
            if missing is not None:
                return ApiResponse(
                    status=ResponseStatus.OK,
                    data={
                        "detail_status": "NO_CHANGE",
                        "interpretation": {"intent": draft.intent, "changes": []},
                    },
                    message=f"비교하려면 값이 하나 더 필요해요. {missing[2]} ({missing[0]}/{len(operation_fields.GUIDED)})",
                )
        return _fill(req, draft, current)
    if wants_run:
        # 화면이 이 표시를 보고 '세 운영안 비교하기'와 같은 계산을 시작한다(입력은 그대로).
        return ApiResponse(
            status=ResponseStatus.OK,
            data={
                "detail_status": "NO_CHANGE",
                "action": "run_operation",
                "interpretation": {"intent": draft.intent, "changes": []},
            },
            message="지금 조건으로 세 운영안 비교를 시작할게요.",
        )
    # 완성본이 있는데 바꿀 값이 없음: 같은 질문 카드를 반복하지 않는다. AI가 답을 만들었으면 그 답을 쓴다.
    reply = draft.reply or (draft.unresolved[0].text if draft.unresolved else None)
    return ApiResponse(
        status=ResponseStatus.OK,
        data={
            "detail_status": "NO_CHANGE",
            "interpretation": {"intent": draft.intent, "changes": []},
        },
        message=reply or _NO_CHANGE_GUIDE,
    )


def _carried_form(req: InterpretRequest) -> dict | None:
    """값을 다시 묻는 질문에 함께 담아 둔 폼 값(아직 아무것도 저장하지 않은 첫 말에서 틀린 값이 나온 경우)."""
    if req.event_type != "question_reply" or not isinstance(req.question, dict):
        return None
    # 질문을 만든 뒤 입력이 바뀌었으면(다른 버전) 그때의 폼 값을 끌어오지 않는다.
    if req.question.get("base_version_id") != req.current_version_id:
        return None
    draft_input = req.question.get("draft_input")
    form = (
        draft_input.get(operation_fields.DRAFT_KEY)
        if isinstance(draft_input, dict)
        else None
    )
    return dict(form) if isinstance(form, dict) else None


def _question(
    req: InterpretRequest,
    key: str,
    text: str,
    *,
    values: dict,
    choices: list[str] | None = None,
    label: str | None = None,
    evidence: list[str] | None = None,
) -> ApiResponse[dict]:
    """운영 값 확인 질문(틀린 값·애매한 값). 말풍선·카드 제목(질문)·카드 설명(칸 이름)을 달리해 같은 말을 반복하지 않는다."""
    previous = (req.question or {}).get("question")
    context = (
        req.content
        if req.event_type == "message"
        else (previous.get("context") if isinstance(previous, dict) else None)
    )
    data = {
        "detail_status": "NEEDS_INPUT",
        "missing_fields": [
            {
                "path": key,
                "label": label or operation_fields.FIELDS.get(key, key),
                "unit": None,
            }
        ],
        "question": {
            "question_key": key,
            "text": text,
            "choices": choices or [],
            "base_version_id": req.current_version_id,
            "context": context,
        },
        "evidence": evidence or [],
        "draft_input": {operation_fields.DRAFT_KEY: values},
    }
    message = "이 값만 다시 확인할게요."
    return needs_input(data, message)


def _saved(
    req: InterpretRequest,
    draft: InterpretDraft,
    candidate: dict,
    message: str,
    assumptions: list[str] | None = None,
) -> ApiResponse[dict]:
    return ApiResponse(
        status=ResponseStatus.OK,
        data={
            "detail_status": "INTERPRETED",
            "interpretation": {
                "intent": "change_input",
                "changes": [c.model_dump() for c in draft.changes],
                "evidence": draft.evidence,
            },
            "parsed_input": {
                "source": req.event_type,
                "changes": [c.model_dump() for c in draft.changes],
                "input": candidate,
            },
            "assumptions": assumptions or [],
            "warnings": [],
        },
        message=message,
    )


def _fill(
    req: InterpretRequest, draft: InterpretDraft, original: dict
) -> ApiResponse[dict]:
    """대화로 못 바꾸는 칸(FORM_ONLY)은 빼고 나머지 값을 반영한 뒤 안내를 덧붙인다.

    "네, 직원 둘이랑 같이 해요"처럼 답(사장님 근무)과 못 바꾸는 칸(인원)이 섞여 와도 답은 버리지 않는다.
    못 바꾸는 칸만 왔으면 전처럼 안내만 한다.
    """
    notes = list(
        dict.fromkeys(
            operation_fields.FORM_ONLY[c.target]
            for c in draft.changes
            if c.target in operation_fields.FORM_ONLY
        )
    )
    kept = [c for c in draft.changes if c.target not in operation_fields.FORM_ONLY]
    if notes and not kept:
        return infeasible(
            {
                "detail_status": "UNSUPPORTED",
                "evidence": draft.evidence,
                "suggestions": notes,
            },
            notes[0],
        )
    response = _apply(req, draft.model_copy(update={"changes": kept}), original)
    if notes:
        response = response.model_copy(
            update={"message": " ".join(part for part in (response.message, *notes) if part)}
        )
    return response


def _apply(
    req: InterpretRequest, draft: InterpretDraft, original: dict
) -> ApiResponse[dict]:
    """운영: 폼 값을 바꿔 저장한다.

    처음 입력은 말할 때마다 지금까지의 폼 값을 저장하고 빠진 필수 값을 묻는다. 말하지 않은 선택 칸은 비워 두고
    계산할 때 기본값을 쓴다(Spring OperationInputBuilder).
    """
    values = operation_fields.form_values(original)
    first = not operation_fields.is_complete(values)
    if first and not values:
        values = _carried_form(req) or {}
    said: dict[str, object] = {}
    for change in draft.changes:
        target = change.target
        if target not in operation_fields.FIELDS:
            return _question(
                req,
                "content",
                "무엇을 바꿀까요? 예) 하루 200건, 라스트오더 7시, 사장님은 안 나와요",
                values=values,
                label="바꿀 수 있는 값: 하루 주문·라스트 오더·사장님 근무·시급·바쁜 시간",
                evidence=draft.evidence,
            )
        try:
            value = operation_fields.normalize(target, change.value)
        except (TypeError, ValueError):
            return _question(
                req,
                target,
                f"{operation_fields.FIELDS[target]}을(를) 다시 알려 주세요.",
                values=values,
                evidence=draft.evidence,
            )
        if target in said and said[target] != value:
            return _question(
                req,
                target,
                f"{operation_fields.FIELDS[target]}을(를) 하나로 정해 주세요.",
                values=values,
                evidence=draft.evidence,
            )
        said[target] = value
        previous = values.get(target)
        values[target] = value
        problem = operation_fields.check(values, target)
        if problem:
            if first:
                # 틀린 값은 저장하지 않는다. 전에 채운 값이 있으면 그대로 둔다.
                if previous is None:
                    values.pop(target)
                else:
                    values[target] = previous
            return _question(
                req, target, problem, values=values, evidence=draft.evidence
            )
    if first:
        missing = operation_fields.next_missing(values)
        if missing is not None:
            step, _, text, _, _ = missing
            ask = f"{text} ({step}/{len(operation_fields.GUIDED)})"
            if not values:
                # 아직 채운 값이 없으면 저장할 것도 없다. 한 번에 말해도 된다고 안내하고 첫 값을 묻는다.
                return ApiResponse(
                    status=ResponseStatus.OK,
                    data={
                        "detail_status": "NO_CHANGE",
                        "interpretation": {"intent": draft.intent, "changes": []},
                    },
                    message=(
                        "운영 실험 조건을 채울게요. 하루 주문, 사장님 근무 여부, 직원 시급을 한 번에 말씀해 주셔도 돼요"
                        f"(예: 하루 200건, 사장님은 안 나와요, 시급 11000원). {ask}"
                    ),
                )
            candidate = {operation_fields.DRAFT_KEY: values}
            if candidate == original:
                # 읽은 값이 없음(답인지 애매 등): AI 답이 있으면 붙여서 같은 값을 다시 묻는다.
                return ApiResponse(
                    status=ResponseStatus.OK,
                    data={
                        "detail_status": "NO_CHANGE",
                        "interpretation": {"intent": draft.intent, "changes": []},
                    },
                    message=" ".join(part for part in (draft.reply, ask) if part),
                )
            return _saved(req, draft, candidate, f"적어 뒀어요. {ask}")
    problem = operation_fields.check_all(values)
    if problem:
        return _question(
            req, problem[0], problem[1], values=values, evidence=draft.evidence
        )
    candidate = {operation_fields.DRAFT_KEY: values}
    if candidate == original:
        return ApiResponse(
            status=ResponseStatus.OK,
            data={
                "detail_status": "NO_CHANGE",
                "interpretation": {"intent": draft.intent, "changes": []},
            },
            message=draft.reply or "입력은 바꾸지 않았어요.",
        )
    if first:
        notes = operation_fields.default_notes(values)
        message = "조건을 다 채웠어요."
        if notes:
            message += " " + ", ".join(notes) + "로 계산해요."
        message += (
            " 아래에서 확인하고 '세 운영안 비교하기'를 누르거나 '비교 시작해줘'라고 말씀해 주세요."
            " 라스트 오더도 '라스트오더 7시'처럼 바꿀 수 있어요."
        )
        return _saved(req, draft, candidate, message, notes)
    return _saved(
        req, draft, candidate, draft.reply or "입력 변경을 반영했어요. 확인해 주세요."
    )
