"""말로 고치기·결과 설명: AI가 고른 값은 칸 정의로 다시 검사하고, 결과에 없는 숫자가 든 문장은 쓰지 않는다."""

import json

import pytest

from app.tools.simulation.roster_chat import chat, explain

FIELDS = [
    {"key": "target_wait_min", "label": "목표 대기(분)", "type": "int", "min": 2, "max": 10},
    {"key": "espresso_machines", "label": "에스프레소 머신", "type": "int", "min": 1, "max": 3},
    {"key": "owner_working", "label": "사장님 근무", "type": "bool"},
    {"key": "owner_days", "label": "사장님 근무 요일", "type": "choices", "choices": ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"],
     "choice_labels": {"MON": "월", "TUE": "화"}},
    {"key": "owner_end", "label": "사장님 퇴근", "type": "time", "min": "07:00", "max": "20:00", "step_min": 30},
    {"key": "basis_day", "label": "계산할 하루", "type": "choice", "choices": ["AVERAGE", "MON", "SAT"]},
    {"key": "workers", "label": "직원 명단", "type": "bool", "time_min": "07:00", "time_max": "20:00"},
]
STATE = {"target_wait_min": 5, "espresso_machines": 1, "owner_working": True, "owner_days": ["MON", "TUE"], "owner_end": "15:00"}
WORKERS = [{"alias": "P1", "days": ["MON"], "start": "07:00", "end": "16:00", "max_hours": 14, "minor": False}]
RESULT = {"options": [{"key": "RECOMMENDED", "peak_wait_min": 2.6, "weekly_cost_krw": 1775040}], "save_peak_wait_min": 3.7}


def ask(reply, **extra):
    seen = {}

    def call(system, user):
        seen["user"] = json.loads(user)
        return json.dumps(reply, ensure_ascii=False)

    body = {"message": extra.pop("message", "토요일은 사장님 못 나와"), "fields": FIELDS, "state": STATE, "workers": WORKERS,
            "result": RESULT, **extra}
    return chat(body, call=call), seen


def test_허용된_칸과_범위_안의_값만_받는다():
    out, seen = ask({"intent": "EDIT", "changes": [
        {"key": "target_wait_min", "value": 3},
        {"key": "espresso_machines", "value": 5},          # 범위 밖 → 거절
        {"key": "owner_days", "value": ["TUE", "MON", "MON"]},  # 순서·중복 정리
        {"key": "owner_end", "value": "13:15"},            # 30분 단위 아님 → 거절
        {"key": "hacker", "value": 1},                     # 목록에 없는 칸 → 무시
    ]})
    assert out["source"] == "LLM" and out["intent"] == "EDIT"
    assert out["changes"] == [{"key": "target_wait_min", "value": 3}, {"key": "owner_days", "value": ["MON", "TUE"]}]
    assert len(out["rejected"]) == 2
    assert out["reply"].startswith("바꿨어요") and "반영하지 못한 것" in out["reply"]
    assert "사장님 근무 요일: 월, 화" in out["reply"]
    # 칸 목록·지금 값·결과를 데이터로 넘긴다
    assert [f["key"] for f in seen["user"]["fields"]] == [f["key"] for f in FIELDS]
    assert seen["user"]["state"]["target_wait_min"] == 5


def test_직원은_별칭으로만_더하고_빼고_고친다():
    out, _ = ask({"intent": "EDIT", "changes": [], "worker_changes": [
        {"op": "add", "alias": "P9", "fields": {"days": ["SAT", "SUN"], "start": "09:00", "end": "13:00", "max_hours": 14}},
        {"op": "add", "fields": {"days": ["SAT"], "start": "13:00", "end": "09:00"}},   # 시작 > 끝 → 거절
        {"op": "remove", "alias": "P1"},
        {"op": "update", "alias": "P7", "fields": {"max_hours": 10}},                # 없는 직원 → 무시
    ]})
    assert [w["op"] for w in out["worker_changes"]] == ["add", "remove"]
    assert out["worker_changes"][0]["fields"]["days"] == ["SAT", "SUN"]
    assert out["rejected"]


def test_질문_답은_결과에_있는_숫자만():
    good, _ = ask({"intent": "ASK", "answer": "추천안은 바쁜 시간 대기가 3.7분에서 2.6분으로 줄어요."}, message="한 명 더 쓰면 얼마나 줄어?")
    assert good["intent"] == "ASK" and "2.6분" in good["reply"]
    bad, _ = ask({"intent": "ASK", "answer": "대기가 1.2분으로 줄어요."}, message="한 명 더 쓰면?")
    assert "1.2" not in bad["reply"] and "숫자" in bad["reply"]


def test_키가_없거나_이상한_답이면_아무것도_바꾸지_않는다():
    out = chat({"message": "머신 2대로", "fields": FIELDS, "state": STATE}, call=lambda s, u: None)
    assert out["source"] == "UNAVAILABLE" and out["changes"] == [] and "직접" in out["reply"]
    out2, _ = ask({"intent": "DELETE_ALL"})
    assert out2["source"] == "UNAVAILABLE"
    # 범위 밖 값만 있던 EDIT는 바꾸지 않고 범위를 알린다(되묻지 않는다)
    out3, _ = ask({"intent": "EDIT", "changes": [{"key": "espresso_machines", "value": 9}], "answer": "무엇을 바꿀까요?"})
    assert out3["changes"] == [] and "1~3 사이만" in out3["reply"]


def test_입력_검사():
    with pytest.raises(ValueError):
        chat({"message": "", "fields": FIELDS}, call=lambda s, u: None)
    with pytest.raises(ValueError):
        chat({"message": "가" * 301, "fields": FIELDS}, call=lambda s, u: None)
    with pytest.raises(ValueError):
        chat({"message": "a", "fields": [{"key": "x", "label": "x", "type": "int"}]}, call=lambda s, u: None)


def test_결과_설명은_결과에_없는_숫자가_있으면_코드_문장을_쓴다():
    ok = explain({"result": RESULT, "fallback": "추천안: 코드 문장"}, call=lambda s, u: '{"text": "추천안은 대기가 2.6분이에요."}')
    assert ok["source"] == "LLM" and "2.6분" in ok["text"]
    bad = explain({"result": RESULT, "fallback": "추천안: 코드 문장"}, call=lambda s, u: '{"text": "대기가 반드시 0.5분 줄어요."}')
    assert bad == {"model_version": "operation.roster_explain.v1", "source": "TEMPLATE", "text": "추천안: 코드 문장"}
    none = explain({"result": RESULT, "fallback": "추천안: 코드 문장"}, call=lambda s, u: None)
    assert none["source"] == "TEMPLATE"
    with pytest.raises(ValueError):
        explain({"result": {}, "fallback": "x"}, call=lambda s, u: None)


WAGE = {"key": "hourly_wage", "label": "직원 시급", "unit": "원", "type": "int", "min": 10320, "max": 100000}


def test_범위_밖이면_코드가_범위를_말한다():
    # "시급 9090원으로": 값만 거절되고 바뀐 게 없어도 이유를 알린다(무엇을 바꿀지 되묻지 않는다)
    out, _ = ask({"intent": "EDIT", "changes": [{"key": "hourly_wage", "value": 9090}]},
                 message="시급 9090원으로", fields=FIELDS + [WAGE])
    assert out["changes"] == [] and out["intent"] == "EDIT"
    assert "직원 시급은 10,320원~100,000원 사이만 돼요." in out["reply"]
    out, _ = ask({"intent": "EDIT", "changes": [{"key": "espresso_machines", "value": 4}]}, message="머신 4대")
    assert "에스프레소 머신은 1~3 사이만 돼요." in out["reply"]


def test_칸_범위_숫자는_답에_써도_된다():
    out, _ = ask({"intent": "ASK", "answer": "최저시급이 10,320원이라 그 아래로는 못 바꿔요."},
                 message="시급 9090원 되나?", fields=FIELDS + [WAGE])
    assert out["reply"] == "최저시급이 10,320원이라 그 아래로는 못 바꿔요."


def test_앞_대화를_같이_보내고_오래된_줄은_자른다():
    history = [{"role": "owner", "text": f"말 {i}"} for i in range(6)] + [{"role": "hacker", "text": "x"}]
    _, seen = ask({"intent": "OTHER", "answer": "네"}, message="그럼 그렇게 해 줘", history=history)
    assert [h["text"] for h in seen["user"]["history"]] == ["말 3", "말 4", "말 5"]


def test_직원_고치기_답장에_무엇을_바꿨는지_쓴다():
    out, _ = ask({"intent": "EDIT", "worker_changes": [
        {"op": "update", "alias": "P1", "fields": {"days": ["MON", "TUE"], "start": "09:00"}}]})
    assert "P1: 가능 요일 월·화 · 시작 09:00" in out["reply"]
