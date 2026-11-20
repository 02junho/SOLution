"""운영 실험 대화 해석. 저장 입력은 폼 값만({"operation_form": {...}}), 근무표 세 안은 계산할 때 Spring이 만든다.

실제 LLM 대신 정해 둔 해석을 돌려주는 가짜 해석기로 service.run만 확인한다(서버·DB 없이).
사장님 말을 읽는 일은 LLM이 한다(키워드 규칙 없음). 여기서는 LLM에 넘기는 요약·규칙과,
LLM이 돌려준 해석을 검사·저장하는 우리 코드를 본다. 실제 LLM이 맞게 읽는지는 live_tests에서 본다.
"""

import json
from copy import deepcopy
from datetime import date
from pathlib import Path

import pytest

from app.agent import operation_fields
from app.agent.interpreter import _build_user_prompt
from app.agent.schemas import Change, InterpretDraft, InterpretRequest
from app.agent.service import run
from app.core.status import ResponseStatus

# 저장된 운영 입력(폼 값만). 시연 업무 2001과 같은 값(사장님 근무, 150건).
SNAPSHOT = {
    "operation_form": {
        "business_date": "2026-11-18",
        "daily_orders": 150,
        "is_owner_working": True,
        "hourly_wage_krw": 10320,
    }
}
# 이 구조 전에 저장된 완성본(근무표까지 든 입력). Spring 운영 계산 테스트도 쓰는 파일이다.
LEGACY_FILE = Path(__file__).resolve().parents[2] / "data" / "demo" / "operation" / "input.json"


class Fake:
    def __init__(self, *changes: Change, intent="change_input"):
        self.draft = InterpretDraft(intent=intent, changes=list(changes))

    def interpret(self, req):
        return self.draft


def _req(**extra):
    body = {
        "store_id": 1,
        "session_id": 2001,
        "feature_type": "operation",
        "event_type": "message",
        "base_version_id": 200101,
        "current_version_id": 200101,
        "current_input": deepcopy(SNAPSHOT),
        "content": "바꿔줘",
    }
    body.update(extra)
    return InterpretRequest(**body)


def _change(target, value, label="값"):
    return Change(field=target, label=label, value=value, target=target)


def _input(response):
    return response.data["parsed_input"]["input"]


def _form(response):
    return _input(response)["operation_form"]


def test_예전_완성본도_폼_값으로_읽고_수정하면_폼_값으로_저장한다():
    legacy = json.loads(LEGACY_FILE.read_text(encoding="utf-8"))
    values = operation_fields.form_values(legacy)
    assert values["daily_orders"] == 200 and values["is_owner_working"] is True
    assert values["hourly_wage_krw"] == 10320 and "last_order_time" not in values
    response = run(_req(current_input=legacy), Fake(_change("daily_orders", 210)))
    assert _form(response)["daily_orders"] == 210 and "labor" not in _input(response)


class Unused:
    """LLM이 답인지 애매해서 바꿀 값을 안 준 경우를 흉내 낸다. 서버는 추측하지 않고 같은 값을 다시 묻는다."""

    def interpret(self, req):
        return InterpretDraft(intent="ask")


def _run_marker():
    from app.agent import operation_flow

    return _change(operation_flow.RUN, 1, "계산 시작")


def _say(current, content):
    return _req(current_input=current, content=content)


def test_대화로_처음_입력하면_말한_값만_저장하고_기본값은_알려_준다():
    response = run(
        _req(current_input=None, content="하루 200건, 사장님도 일하고 시급 11000원"),
        Fake(
            _change("daily_orders", 200),
            _change("is_owner_working", 1),
            _change("hourly_wage_krw", 11000),
        ),
    )
    assert (
        response.status == ResponseStatus.OK
        and response.data["detail_status"] == "INTERPRETED"
    )
    # 근무표는 계산할 때 Spring이 만든다. 말하지 않은 라스트 오더는 비워 두고 기본값으로 계산한다고 알린다.
    assert _input(response) == {
        "operation_form": {"daily_orders": 200, "is_owner_working": True, "hourly_wage_krw": 11000}
    }
    assert "18:45" in response.message
    assert response.data["assumptions"]


def test_처음_입력은_매입처럼_말할_때마다_작성_중으로_저장하고_다음_값을_묻는다(
    monkeypatch,
):
    # 해가 바뀌면 최저시급이 달라지므로 날짜를 고정한다(2026년 최저시급 10,320원).
    monkeypatch.setattr(operation_fields, "today", lambda: date(2026, 11, 18))
    start = run(_say(None, "운영 실험 해 볼래"), Fake(intent="ask"))
    assert (
        start.status == ResponseStatus.OK and start.data["detail_status"] == "NO_CHANGE"
    )
    assert (
        "몇 건" in start.message and "(1/3)" in start.message
    )  # 질문 카드 없이 말풍선으로

    assert "한 번에" in start.message  # 자유롭게 말해도 된다고 안내

    one = run(_say(None, "200건"), Fake(_change("daily_orders", 200)))
    assert one.status == ResponseStatus.OK and _input(one) == {
        "operation_form": {"daily_orders": 200}
    }
    assert "(2/3)" in one.message and "사장님" in one.message

    two = run(_say(_input(one), "아니요, 직원만 일해요"), Fake(_change("is_owner_working", 0)))
    assert _input(two) == {
        "operation_form": {"daily_orders": 200, "is_owner_working": False}
    }
    assert "(3/3)" in two.message and "시급" in two.message

    done = run(_say(_input(two), "최저시급으로 할게요"), Fake(_change("hourly_wage_krw", 10320)))
    assert _input(done) == {
        "operation_form": {"daily_orders": 200, "is_owner_working": False, "hourly_wage_krw": 10320}
    }
    assert "세 운영안 비교하기" in done.message


def test_작성_중에는_말한_순서와_상관없이_이미_채운_값은_건너뛴다():
    response = run(
        _say(None, "사장님은 안 나가요"), Fake(_change("is_owner_working", 0))
    )
    assert _input(response) == {"operation_form": {"is_owner_working": False}}
    assert "(1/3)" in response.message and "몇 건" in response.message


def test_작성_중_틀린_값은_저장하지_않고_다시_묻는다():
    draft = {"operation_form": {"is_owner_working": False}}
    wrong = run(_say(draft, "500건"), Fake(_change("daily_orders", 500)))
    assert wrong.status == ResponseStatus.NEEDS_INPUT
    assert (
        wrong.data["question"]["question_key"] == "daily_orders"
        and "300" in wrong.data["question"]["text"]
    )
    texts = {
        wrong.message,
        wrong.data["question"]["text"],
        wrong.data["missing_fields"][0]["label"],
    }
    assert len(texts) == 3  # 같은 말 세 번 반복하지 않음


def test_입력이_있는데_바꿀_값이_없으면_질문_대신_계산_버튼을_안내한다():
    response = run(_req(content="음 그렇구나"), Fake(intent="ask"))
    assert (
        response.status == ResponseStatus.OK
        and response.data["detail_status"] == "NO_CHANGE"
    )
    assert "세 운영안 비교하기" in response.message


def test_하루_주문과_라스트오더를_바꾸면_그_칸만_바뀐다():
    response = run(
        _req(), Fake(_change("daily_orders", 200), _change("last_order_time", "19:00"))
    )
    assert _form(response) == {
        **SNAPSHOT["operation_form"],
        "daily_orders": 200,
        "last_order_time": "19:00",
    }


def test_사장님_근무와_시급도_폼_값으로_바꾼다():
    assert _form(run(_req(), Fake(_change("is_owner_working", 0))))["is_owner_working"] is False
    assert _form(run(_req(), Fake(_change("hourly_wage_krw", 11000))))["hourly_wage_krw"] == 11000


def test_바쁜_시간은_입력이_아니라_상권_데이터로_정해져_있다고_안내한다():
    response = run(_req(), Fake(_change("rush_start_time", "12:00")))
    assert response.status == ResponseStatus.INFEASIBLE
    assert "11:00~14:00" in response.message


def test_최저시급보다_낮으면_바꾸지_않고_되묻는다():
    response = run(_req(), Fake(_change("hourly_wage_krw", 9000)))
    assert (
        response.status == ResponseStatus.NEEDS_INPUT
        and "10,320" in response.data["question"]["text"]
    )


def test_폼과_같은_범위를_검사한다():
    for changes in [
        [("daily_orders", 301)],
        [("daily_orders", 0)],
        [("last_order_time", "18:00")],
        [("last_order_time", "7시")],
        [("order_time_sec", 0)],
        [("handoff_time_sec", 301)],
        [("is_owner_working", "몰라")],
    ]:
        response = run(_req(), Fake(*[_change(t, v) for t, v in changes]))
        assert response.status == ResponseStatus.NEEDS_INPUT, changes


def test_비교_안_자체를_바꾸는_값은_안내한다():
    for target, value in [
        ("staff_count", 3),
        ("open_time", "08:00"),
        ("repeat_count", 50),
        ("menu_weights", 1),
    ]:
        response = run(_req(), Fake(_change(target, value)))
        assert response.status == ResponseStatus.INFEASIBLE, target
        assert response.data["detail_status"] == "UNSUPPORTED"


def test_LLM_요약에_화면_표기를_넣고_화면_문구와_같다():

    from app.agent import operation_flow

    for current in ({"operation_form": {"daily_orders": 150}}, deepcopy(SNAPSHOT)):
        summary = json.loads(operation_flow.prompt_summary(_req(current_input=current)))
        assert summary["화면 표기"]["is_owner_working"] == {"1": "사장님 + 직원 1명", "0": "직원 2명"}
    review = Path(__file__).resolve().parents[2] / "frontend/src/features/operation/workspace/OperationInputReview.tsx"
    if review.exists():  # ai-server만 따로 돌릴 때는 건너뜀
        text = review.read_text(encoding="utf-8")
        for label in operation_fields.VALUE_LABELS["is_owner_working"].values():
            assert f"'{label}'" in text, label


def test_답과_대화로_못_바꾸는_칸이_섞이면_답은_반영하고_안내를_덧붙인다():
    # "네, 직원 둘이랑 같이 해요": 사장님 근무 답 + 인원(대화로 못 바꿈)
    current = {"operation_form": {"daily_orders": 150}}
    response = run(
        _req(current_input=current),
        Fake(_change("is_owner_working", 1), _change("staff_count", 3)),
    )
    assert response.status == ResponseStatus.OK
    form = response.data["parsed_input"]["input"]["operation_form"]
    assert form == {"daily_orders": 150, "is_owner_working": True}
    assert "인원은 비교 안에 이미 들어 있어요" in response.message


def test_같은_값이면_바뀐_것이_없다고_답한다():
    response = run(_req(), Fake(_change("daily_orders", 150)))
    assert (
        response.status == ResponseStatus.OK
        and response.data["detail_status"] == "NO_CHANGE"
    )


def test_LLM에는_지금_폼_값과_기본값을_요약해_준다():
    prompt = _build_user_prompt(_req())
    assert '"daily_orders": 150' in prompt and '"hourly_wage_krw": 10320' in prompt
    assert "18:45(기본)" in prompt and "11:00~14:00" in prompt


def test_입력이_있을_때_설명_질문에는_AI_답을_그대로_쓴다():
    class Asks:
        def interpret(self, req):
            return InterpretDraft(
                intent="ask", reply="서로 돕기는 바쁜 시간에만 주문·제조를 서로 도와요."
            )

    response = run(_req(content="서로 돕기가 뭐야?"), Asks())
    assert (
        response.status == ResponseStatus.OK
        and response.data["detail_status"] == "NO_CHANGE"
    )
    assert response.message.startswith("서로 돕기는")


def test_LLM이_실행_표시를_주면_입력이_다_있을_때_계산_시작_표시를_보낸다():
    response = run(_req(content="비교해줘"), Fake(_run_marker()))
    assert response.data.get("action") == "run_operation"
    # 질문이나 하지 말라는 말은 LLM이 실행 표시를 주지 않는다 → 계산 시작 안 함
    question = run(_req(content="서로 돕기랑 비교하면 뭐가 나아?"), Fake(intent="ask"))
    assert "action" not in question.data


def test_LLM이_잡담으로_분류해도_실행_표시가_있으면_계산을_시작한다():
    # 예전에는 "비교해줘"가 잡담으로 분류되면 공통 흐름으로 넘어가 동문서답했다.
    response = run(_req(content="비교해줘"), Fake(_run_marker(), intent="smalltalk"))
    assert response.data.get("action") == "run_operation"


def test_실행_표시와_값이_같이_오면_값만_바꾸고_계산은_시작하지_않는다():
    response = run(_req(content="200건으로 하고 비교해줘"), Fake(_change("daily_orders", 200), _run_marker()))
    assert "action" not in response.data and _form(response)["daily_orders"] == 200


def test_채우는_중에_비교해_달라면_남은_값을_묻는다():
    draft = {"operation_form": {"daily_orders": 200}}
    response = run(_req(current_input=draft, content="비교 시작해줘"), Fake(_run_marker()))
    assert "action" not in response.data and "(2/3)" in response.message


def test_채우는_중_LLM에_방금_물은_칸과_최저시급을_같이_넘긴다(monkeypatch):
    monkeypatch.setattr(operation_fields, "today", lambda: date(2026, 11, 18))
    draft = {"operation_form": {"daily_orders": 200, "is_owner_working": False}}
    prompt = _build_user_prompt(_req(current_input=draft, content="최저"))
    assert "방금 물은 칸" in prompt and '"target": "hourly_wage_krw"' in prompt
    assert '"최저시급": 10320' in prompt


def test_채우는_중_LLM이_답을_못_읽으면_추측하지_않고_다시_묻는다():
    draft = {"operation_form": {"daily_orders": 200}}
    response = run(_req(current_input=draft, content="음.."), Unused())
    assert response.data["detail_status"] == "NO_CHANGE" and "(2/3)" in response.message


def test_채우는_중_잡담에는_AI_답_뒤에_묻던_값을_다시_묻는다():
    class Smalltalk:
        def interpret(self, req):
            return InterpretDraft(intent="smalltalk", reply="반가워요!")

    draft = {"operation_form": {"daily_orders": 200}}
    response = run(_req(current_input=draft, content="안녕"), Smalltalk())
    assert response.message.startswith("반가워요!") and "(2/3)" in response.message


def test_작성_중_틀린_값이_와도_전에_채운_값은_그대로_둔다():
    draft = {"operation_form": {"daily_orders": 200}}
    wrong = run(_say(draft, "주문 500건"), Fake(_change("daily_orders", 500)))
    assert wrong.status == ResponseStatus.NEEDS_INPUT
    assert wrong.data["draft_input"] == {"operation_form": {"daily_orders": 200}}


def test_실행_표시는_값이_1일_때만_계산을_시작한다():
    for value in (0, None, "1", "네"):
        response = run(_req(), Fake(_change("run_comparison", value)))
        assert (response.data or {}).get("action") != "run_operation", value
    assert run(_req(), Fake(_change("run_comparison", 1))).data["action"] == "run_operation"


def test_값을_바꾸며_비교해_달라고_하면_값을_먼저_저장하고_바로_계산하지_않는다():
    response = run(_req(), Fake(_change("daily_orders", 200), _change("run_comparison", 1)))
    assert response.data.get("action") != "run_operation"
    assert response.data["parsed_input"]["input"]["operation_form"]["daily_orders"] == 200


def test_첫_말에서_틀린_값을_다시_물을_때_LLM_요약은_질문에_담긴_폼_값을_본다():
    from app.agent import operation_flow

    carried = {"daily_orders": 150, "is_owner_working": True}
    req = _req(
        current_input=None,
        event_type="question_reply",
        content="11000",
        question={
            "base_version_id": 200101,
            "draft_input": {"operation_form": carried},
            "question": {"question_key": "hourly_wage_krw"},
        },
    )
    summary = json.loads(operation_flow.prompt_summary(req))
    assert summary["작성 중"] == carried
    assert summary["방금 물은 칸"]["target"] == "hourly_wage_krw"


def test_다_채우면_요약에_지금_상태를_넣고_채우는_중에는_넣지_않는다():
    from app.agent import operation_flow

    done = json.loads(operation_flow.prompt_summary(_req(current_input=deepcopy(SNAPSHOT))))
    assert done["지금 상태"] == operation_flow.READY_STATE
    filling = json.loads(operation_flow.prompt_summary(_req(current_input={"operation_form": {"daily_orders": 150}})))
    assert "지금 상태" not in filling
    assert "'지금 상태'" in operation_flow.PROMPT_RULE


def test_바꿀_수_없는_칸이면_바꿀_수_있는_값을_안내하고_고정값은_넣지_않는다():
    complete = deepcopy(SNAPSHOT)
    response = run(_req(current_input=complete), Fake(_change("menu_count", 10)))
    assert response.status == ResponseStatus.NEEDS_INPUT
    text = json.dumps(response.data, ensure_ascii=False)
    for name in operation_fields.FIELDS.values():
        assert name in text, name
    assert "바쁜 시간" not in text


def _wage_question_reply(content="11000", **overrides):
    """첫 말 '하루 150건, 시급 9000원' 뒤 시급을 다시 묻는 질문에 답하는 요청(아직 저장한 값 없음)."""
    base = dict(
        current_input=None,
        event_type="question_reply",
        content=content,
        question_id="q-wage",
        answer=content,
        question={
            "base_version_id": 200101,
            "draft_input": {"operation_form": {"daily_orders": 150}},
            "question": {"question_key": "hourly_wage_krw", "text": "직원 시급은 최저시급 이상이어야 해요. 얼마인가요?"},
        },
    )
    base.update(overrides)
    return _req(**base)


def test_방금_물은_칸은_실제로_발급한_질문의_칸을_쓴다():
    from app.agent import operation_flow

    # 다음 빈 칸 순서로는 사장님 근무지만, 실제로 물은 건 시급이다.
    summary = json.loads(operation_flow.prompt_summary(_wage_question_reply()))
    assert summary["방금 물은 칸"]["target"] == "hourly_wage_krw"
    assert summary["방금 물은 칸"]["질문"] == "직원 시급은 최저시급 이상이어야 해요. 얼마인가요?"
    # 발급한 질문이 폼 칸이 아니면 다음 빈 칸.
    other = _wage_question_reply(
        question={
            "base_version_id": 200101,
            "draft_input": {"operation_form": {"daily_orders": 150}},
            "question": {"question_key": "content"},
        }
    )
    assert json.loads(operation_flow.prompt_summary(other))["방금 물은 칸"]["target"] == "is_owner_working"
    # 다 채운 뒤 값을 바꾸다 다시 물은 경우에도 그 칸.
    done = _req(
        current_input=deepcopy(SNAPSHOT),
        event_type="question_reply",
        content="11000",
        question={"base_version_id": 200101, "question": {"question_key": "hourly_wage_krw"}},
    )
    assert json.loads(operation_flow.prompt_summary(done))["방금 물은 칸"]["target"] == "hourly_wage_krw"


def test_저장한_값이_없을_때_잡담하면_질문에_담아_둔_값_다음_칸을_묻는다():
    class Chat:
        def interpret(self, req):
            return InterpretDraft(intent="smalltalk", reply="네, 천천히 알려 주세요.")

    response = run(_wage_question_reply(content="잠깐만요"), Chat())
    assert response.data["detail_status"] == "NO_CHANGE"
    assert "하루에 주문이" not in response.message  # 이미 받은 하루 주문을 다시 묻지 않는다
    assert "(2/3)" in response.message


def test_처음에_질문하면_AI_설명_뒤에_첫_값을_묻는다():
    class Ask:
        def interpret(self, req):
            return InterpretDraft(intent="ask", reply="서로 돕기는 바쁜 시간에 주문과 제조를 서로 돕는 방식이에요.")

    response = run(_req(current_input=None, content="서로 돕기가 뭐야?"), Ask())
    assert response.message.startswith("서로 돕기는")
    assert "(1/3)" in response.message


def test_무한대_같은_숫자는_폼_값으로_받지_않는다():
    with pytest.raises(ValueError):
        operation_fields.normalize("daily_orders", float("inf"))


def test_운영_규칙은_운영_요청의_지시문에만_붙는다():
    from app.agent import operation_flow

    assert operation_flow.prompt_rule(_req()) == operation_flow.PROMPT_RULE
    assert operation_flow.prompt_rule(_req(feature_type="purchase")) == ""


def test_정하지_않은_라스트_오더만_기본값으로_알린다():
    assert operation_fields.default_notes({"daily_orders": 100}) == ["라스트 오더는 기본 18:45"]
    assert operation_fields.default_notes({"last_order_time": "19:00"}) == []
