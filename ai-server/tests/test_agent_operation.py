"""운영 실험 대화 해석. 처음 입력은 말한 값 + 기본값으로 근무표까지 만들고, 수정은 폼 값으로 읽어 다시 만든다.

실제 LLM 대신 정해 둔 해석을 돌려주는 가짜 해석기로 service.run만 확인한다(서버·DB 없이).
"""

import json
from copy import deepcopy
from pathlib import Path

import pytest

from app.agent import operation_fields
from app.agent.interpreter import _build_user_prompt
from app.agent.schemas import Change, InterpretDraft, InterpretRequest
from app.agent.service import run
from app.core.status import ResponseStatus

# Spring OperationInputBuilder 결과 기준 파일. Spring 테스트(OperationInputBuilderCasesTest)도 같은 파일을 본다.
# 빌더 규칙을 바꾸면 두 빌더와 이 파일을 같이 고친다(뽑는 방법은 Spring 테스트 주석 참고).
CASES_FILE = (
    Path(__file__).resolve().parents[2]
    / "data"
    / "demo"
    / "operation"
    / "input_builder_cases.json"
)
CASES = json.loads(CASES_FILE.read_text(encoding="utf-8"))
SNAPSHOT = CASES["owner_default"][
    "input"
]  # Spring 빌더가 만든 완성본(사장님 근무, 150건)


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


@pytest.mark.parametrize("name", list(CASES))
def test_파이썬_빌더는_Spring_빌더와_같은_완성본을_만든다(name):
    form = {k: v for k, v in CASES[name]["form"].items() if v is not None}
    form.setdefault("last_order_time", operation_fields.DEFAULT_LAST_ORDER)
    form.setdefault("rush_start_time", operation_fields.DEFAULT_RUSH[0])
    form.setdefault("rush_end_time", operation_fields.DEFAULT_RUSH[1])
    assert operation_fields.build(form) == CASES[name]["input"]


@pytest.mark.parametrize("name", list(CASES))
def test_완성본에서_읽은_폼_값으로_다시_만들면_그대로다(name):
    snapshot = CASES[name]["input"]
    assert operation_fields.build(operation_fields.read_values(snapshot)) == snapshot


class Unused:
    """LLM이 짧은 답을 못 읽은 경우(바꿀 값 없음)를 흉내 낸다. 서버가 다음에 물은 칸의 답으로 직접 읽어야 한다."""

    def interpret(self, req):
        return InterpretDraft(intent="ask")


def _say(current, content):
    return _req(current_input=current, content=content)


def test_대화로_처음_입력하면_말한_값과_기본값으로_근무표까지_만든다():
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
    made = _input(response)
    assert made["simulation"]["scenario"]["daily_orders"] == 200
    assert [p["choice_key"] for p in made["labor"]["plans"]] == [
        "CURRENT",
        "ALT_A",
        "ALT_C",
    ]
    assert [w["hourly_wage_krw"] for w in made["labor"]["workers"]] == [
        None,
        11000,
        11000,
    ]
    # 묻지 않은 값(라스트 오더, 바쁜 시간)은 기본값으로 넣고 알려 준다.
    assert "18:45" in response.message and "11:00~14:00" in response.message
    assert response.data["assumptions"]


def test_처음_입력은_매입처럼_말할_때마다_작성_중으로_저장하고_다음_값을_묻는다():
    start = run(_say(None, "운영 실험 해 볼래"), Fake(intent="ask"))
    assert (
        start.status == ResponseStatus.OK and start.data["detail_status"] == "NO_CHANGE"
    )
    assert (
        "몇 건" in start.message and "(1/3)" in start.message
    )  # 질문 카드 없이 말풍선으로

    one = run(_say(None, "200건"), Unused())
    assert one.status == ResponseStatus.OK and _input(one) == {
        "operation_form": {"daily_orders": 200}
    }
    assert "(2/3)" in one.message and "사장님" in one.message

    two = run(_say(_input(one), "아니요, 직원만 일해요"), Unused())
    assert _input(two) == {
        "operation_form": {"daily_orders": 200, "is_owner_working": False}
    }
    assert "(3/3)" in two.message and "시급" in two.message

    done = run(_say(_input(two), "최저시급으로 할게요"), Unused())
    made = _input(done)
    assert made["simulation"]["scenario"]["daily_orders"] == 200
    assert all(not w["is_owner"] for w in made["labor"]["workers"])
    assert [w["hourly_wage_krw"] for w in made["labor"]["workers"]] == [
        10320,
        10320,
        10320,
    ]
    assert "세 운영안 비교하기" in done.message


def test_작성_중에는_말한_순서와_상관없이_이미_채운_값은_건너뛴다():
    response = run(
        _say(None, "사장님은 안 나가요"), Fake(_change("is_owner_working", 0))
    )
    assert _input(response) == {"operation_form": {"is_owner_working": False}}
    assert "(1/3)" in response.message and "몇 건" in response.message


def test_작성_중_틀린_값은_저장하지_않고_다시_묻는다():
    draft = {"operation_form": {"is_owner_working": False}}
    wrong = run(_say(draft, "500건"), Unused())
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


def test_하루_주문과_라스트오더를_바꾸고_근무표는_그대로다():
    response = run(
        _req(), Fake(_change("daily_orders", 200), _change("last_order_time", "19:00"))
    )
    scenario = _input(response)["simulation"]["scenario"]
    assert scenario["daily_orders"] == 200 and scenario["last_order_time"] == "19:00"
    assert _input(response)["labor"]["plans"] == SNAPSHOT["labor"]["plans"]


def test_사장님_근무를_빼면_직원_두_명_근무표로_다시_만든다():
    response = run(_req(), Fake(_change("is_owner_working", 0)))
    labor = _input(response)["labor"]
    assert all(not w["is_owner"] for w in labor["workers"])
    assert {s["worker_key"] for s in labor["plans"][0]["shifts"]} == {
        "STAFF_1",
        "STAFF_2",
    }


def test_바쁜_시간을_바꾸면_서로_돕기와_한_명_추가_구간이_같이_바뀐다():
    response = run(
        _req(),
        Fake(_change("rush_start_time", "12:00"), _change("rush_end_time", "15:00")),
    )
    labor = _input(response)["labor"]
    assert labor["avoid_break_windows"] == [
        {"start_time": "12:00", "end_time": "15:00"}
    ]
    extra = [s for s in labor["plans"][2]["shifts"] if s["worker_key"] == "STAFF_2"]
    assert (extra[0]["start_time"], extra[0]["end_time"]) == ("12:00", "15:00")


def test_시급은_직원_모두에게_넣고_사장님은_비워_둔다():
    workers = _input(run(_req(), Fake(_change("hourly_wage_krw", 11000))))["labor"][
        "workers"
    ]
    assert [w["hourly_wage_krw"] for w in workers] == [None, 11000, 11000]


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
        [("rush_start_time", "15:00")],
        [("rush_start_time", "06:00")],
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


def test_같은_값이면_바뀐_것이_없다고_답한다():
    response = run(_req(), Fake(_change("daily_orders", 150)))
    assert (
        response.status == ResponseStatus.OK
        and response.data["detail_status"] == "NO_CHANGE"
    )


def test_LLM에는_근무표_대신_바꿀_수_있는_값만_요약해_준다():
    prompt = _build_user_prompt(_req())
    assert '"daily_orders": 150' in prompt and '"hourly_wage_krw": 10320' in prompt
    assert "plans" not in prompt and "STAFF_1" not in prompt
    assert operation_fields.summary(SNAPSHOT)["rush"] == "11:00~14:00"


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


def test_채우는_중_응_같은_짧은_답은_AI가_잡담으로_봐도_읽는다():
    class Smalltalk:
        def interpret(self, req):
            return InterpretDraft(intent="smalltalk", reply="네!")

    draft = {"operation_form": {"daily_orders": 200}}
    response = run(_req(current_input=draft, content="응"), Smalltalk())
    assert _input(response) == {
        "operation_form": {"daily_orders": 200, "is_owner_working": True}
    }


def test_비교_시작해줘는_입력이_다_있으면_계산_시작_표시를_보낸다():
    response = run(_req(content="운영안 비교 시작"), Fake(intent="ask"))
    assert response.data.get("action") == "run_operation"
    question = run(_req(content="서로 돕기랑 비교하면 뭐가 나아?"), Fake(intent="ask"))
    assert "action" not in question.data


def test_채우는_중에_비교해_달라면_남은_값을_묻는다():
    draft = {"operation_form": {"daily_orders": 200}}
    response = run(
        _req(current_input=draft, content="비교 시작해줘"), Fake(intent="ask")
    )
    assert "action" not in response.data and "(2/3)" in response.message


def test_사장님_근무_질문에_같은_글자로_시작하는_다른_말은_답으로_읽지_않는다():
    read = operation_fields.parse_answer
    assert read("is_owner_working", "어") == 1
    assert read("is_owner_working", "네, 같이 일해요") == 1
    assert read("is_owner_working", "어떻게 해야 돼요?") is None
    assert read("is_owner_working", "예를 들면요?") is None
    assert read("is_owner_working", "아니요, 직원만 일해요") == 0


def test_작성_중_틀린_값이_와도_전에_채운_값은_그대로_둔다():
    draft = {"operation_form": {"daily_orders": 200}}
    wrong = run(_say(draft, "주문 500건"), Fake(_change("daily_orders", 500)))
    assert wrong.status == ResponseStatus.NEEDS_INPUT
    assert wrong.data["draft_input"] == {"operation_form": {"daily_orders": 200}}


def test_무한대_같은_숫자는_폼_값으로_받지_않는다():
    with pytest.raises(ValueError):
        operation_fields.normalize("daily_orders", float("inf"))


def test_운영_규칙은_운영_요청의_지시문에만_붙는다():
    from app.agent import operation_flow

    assert operation_flow.prompt_rule(_req()) == operation_flow.PROMPT_RULE
    assert operation_flow.prompt_rule(_req(feature_type="purchase")) == ""


def test_영업일이_비어_있으면_오늘로_채운다():
    values = {"business_date": None, "daily_orders": 100}
    operation_fields.fill_defaults(values)
    assert values["business_date"] == operation_fields.today().isoformat()
