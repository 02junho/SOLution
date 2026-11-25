"""실제 유료 호출 없이 SDK 옵션·거절·재시도·형식 보정·개인정보 경계를 검증한다."""

import json
from types import SimpleNamespace

import pytest

import app.agent.interpreter as module
from app.agent.interpreter import LlmInterpreter, LlmUnavailable, _build_user_prompt, _parse
from app.agent.schemas import Change, InterpretDraft, InterpretRequest
from app.core.config import Settings


@pytest.fixture
def interpret_request():
    return InterpretRequest(store_id=10, session_id=100, feature_type="purchase", event_type="message", content="예산 변경")


@pytest.fixture(autouse=True)
def settings(monkeypatch):
    monkeypatch.setattr(module, "get_settings", lambda: Settings(_env_file=None, anthropic_api_key="local-test-only"))


def test_모델은_설정에서_읽고_금지옵션과_SDK재시도를_넣지_않는다(monkeypatch, interpret_request):
    import langchain_anthropic

    captured = {}

    class Model:
        def __init__(self, **kwargs):
            captured.update(kwargs)

        def with_structured_output(self, schema, **kwargs):
            captured["schema"] = schema
            captured["structured_options"] = kwargs
            return self

        def invoke(self, messages):
            assert messages[-1][0] == "human"
            return {"raw": SimpleNamespace(content=[{"type": "text", "text": '{"intent":"smalltalk"}'}], response_metadata={}),
                    "parsed": None}

    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", Model)
    model_settings = Settings(_env_file=None, anthropic_api_key="local-test-only", anthropic_model="configured-model")
    assert json.loads(LlmInterpreter()._call(model_settings, "system", "user"))["intent"] == "smalltalk"
    assert captured["model"] == "configured-model"
    assert captured["max_retries"] == 0
    assert captured["schema"] is InterpretDraft
    assert captured["structured_options"] == {"method": "json_schema", "include_raw": True}
    assert not {"temperature", "top_p", "thinking", "tool_choice"}.intersection(captured)


def test_안전분류기_거절은_정상_JSON이_있어도_해석하지_않는다(monkeypatch):
    import langchain_anthropic

    model = SimpleNamespace(with_structured_output=lambda *_, **__: SimpleNamespace(invoke=lambda _: {
        "raw": SimpleNamespace(content='{"intent":"smalltalk"}', response_metadata={"stop_reason": "refusal"}),
        "parsed": InterpretDraft(intent="smalltalk")}))
    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", lambda **_: model)
    with pytest.raises(LlmUnavailable) as exc:
        LlmInterpreter()._call(Settings(_env_file=None, anthropic_api_key="local-test-only"), "system", "user")
    assert exc.value.refused


def test_JSON_형식보정은_한번만_하고_실패하면_질문한다(monkeypatch, interpret_request):
    calls = []
    interpreter = LlmInterpreter()
    monkeypatch.setattr(interpreter, "_call", lambda *args: calls.append(args) or "not-json")
    result = interpreter.interpret(interpret_request)
    assert len(calls) == 2
    assert result.intent == "ask"
    assert result.unresolved


def test_전송실패_재시도와_형식보정은_별도이며_전체4회_이내이다(monkeypatch, interpret_request):
    calls = []
    interpreter = LlmInterpreter()

    def call(*args):
        calls.append(args)
        if len(calls) in {1, 3}:
            raise LlmUnavailable("일시적 실패", retryable=True)
        return "invalid" if len(calls) == 2 else '{"intent":"smalltalk"}'

    monkeypatch.setattr(interpreter, "_call", call)
    assert interpreter.interpret(interpret_request).intent == "smalltalk"
    assert len(calls) == 4


def test_연결실패는_최대2회_재시도한다(monkeypatch, interpret_request):
    interpreter = LlmInterpreter()
    calls = []

    def call(*args):
        calls.append(args)
        raise LlmUnavailable("연결 실패", retryable=True)

    monkeypatch.setattr(interpreter, "_call", call)
    with pytest.raises(LlmUnavailable):
        interpreter.interpret(interpret_request)
    assert len(calls) == 3


def test_인증실패와_거절은_재시도하지_않는다(monkeypatch, interpret_request):
    for error in [LlmUnavailable("인증 실패"), LlmUnavailable("거절", refused=True)]:
        interpreter = LlmInterpreter()
        calls = []

        def call(*args):
            calls.append(args)
            raise error

        monkeypatch.setattr(interpreter, "_call", call)
        with pytest.raises(LlmUnavailable):
            interpreter.interpret(interpret_request)
        assert len(calls) == 1


def test_질문내용과_선택지를_프롬프트에_넣고_중첩_개인정보를_가린다(interpret_request):
    interpret_request = interpret_request.model_copy(update={"event_type": "question_reply", "question_id": "q-test",
        "answer": {"contact": "010-1234-5678 a@b.com", "person_name": "홍길동"},
        "current_input": {"note": "담당자 홍길동 02-123-4567"},
        "question": {"missing_fields": [{"path": "budget_krw", "label": "예산"}]}})
    prompt = _build_user_prompt(interpret_request)
    assert "budget_krw" in prompt and "예산" in prompt
    assert all(value not in prompt for value in ["010-1234-5678", "a@b.com", "홍길동", "02-123-4567"])


def test_유한하지_않은_수치는_형식검증을_통과하지_못한다():
    assert _parse('{"intent":"change_input","changes":[{"field":"budget_krw","label":"예산","target":"budget_krw","value":NaN}]}') is None


def test_참거짓을_숫자로_해석하지_않는다():
    assert _parse('{"intent":"change_input","changes":[{"field":"budget_krw","label":"예산","target":"budget_krw","value":true}]}') is None


@pytest.mark.parametrize("text,expected", [
    ("01012345678", "[전화번호]"), ("010-1234-5678", "[전화번호]"),
    ("02 123 4567", "[전화번호]"), ("031-1234-5678", "[전화번호]"),
    ("901012345678", "901012345678"), ("010123456789", "010123456789"),
    # 국가번호(+82)가 붙은 형식. 앞자리 0은 붙여도 빼도 가린다.
    ("+82 10-1234-5678", "[전화번호]"), ("+82-10-1234-5678", "[전화번호]"),
    ("+821012345678", "[전화번호]"), ("+82 2-123-4567", "[전화번호]"), ("+82 010-1234-5678", "[전화번호]"),
    # + 없이 82로 시작하는 숫자는 금액·수량일 수 있어 그대로 둔다.
    ("821012345678", "821012345678"),
])
def test_전화번호_경계를_지키고_긴_수치문자열을_손상시키지_않는다(text, expected):
    from app.agent.privacy import sanitize

    assert sanitize(text) == expected


@pytest.mark.parametrize("error,retryable", [(TimeoutError("private"), True), (ValueError("private"), False)])
def test_SDK_오류는_민감한_내용을_숨기고_재시도_가능여부를_분류한다(monkeypatch, error, retryable):
    import langchain_anthropic

    def invoke(_):
        raise error

    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", lambda **_: SimpleNamespace(
        with_structured_output=lambda *_, **__: SimpleNamespace(invoke=invoke)))
    with pytest.raises(LlmUnavailable) as exc:
        LlmInterpreter()._call(Settings(_env_file=None, anthropic_api_key="local-test-only"), "system", "user")
    assert exc.value.retryable is retryable
    assert "private" not in str(exc.value)



def test_구조화_출력의_검증된_수치와_target_unit을_사용한다(monkeypatch):
    import langchain_anthropic

    parsed = InterpretDraft(intent="change_input", changes=[Change(
        field="budget_krw", label="예산", value=120000, target="budget_krw", unit=None)])
    model = SimpleNamespace(with_structured_output=lambda *_, **__: SimpleNamespace(invoke=lambda _: {
        "raw": SimpleNamespace(content="unstructured text", response_metadata={}), "parsed": parsed}))
    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", lambda **_: model)
    settings = Settings(_env_file=None, anthropic_api_key="local-test-only")
    result = json.loads(LlmInterpreter()._call(settings, "system", "user"))
    assert result["changes"][0]["target"] == "budget_krw"
    assert result["changes"][0]["unit"] is None
    assert result["changes"][0]["value"] == 120000



def test_출력_상한으로_잘린_해석은_파싱돼도_사용하지_않는다(monkeypatch):
    import langchain_anthropic

    parsed = InterpretDraft(intent="smalltalk")
    model = SimpleNamespace(with_structured_output=lambda *_, **__: SimpleNamespace(invoke=lambda _: {
        "raw": SimpleNamespace(content="{}", response_metadata={"stop_reason": "max_tokens"}), "parsed": parsed}))
    monkeypatch.setattr(langchain_anthropic, "ChatAnthropic", lambda **_: model)
    with pytest.raises(LlmUnavailable):
        LlmInterpreter()._call(Settings(_env_file=None, anthropic_api_key="local-test-only"), "system", "user")


def test_prompt_names_suppliers_instead_of_ids():
    from app.agent.interpreter import _named_suppliers
    current = {
        "budget_krw": 200000,
        "quotes": [{"item_id": "beans", "supplier_id": "R1", "pack_price_krw": 19000}],
        "suppliers": [{"supplier_id": "R1", "supplier_name": "원두 로스터리 가"}],
    }
    named = _named_suppliers(current)
    assert named["quotes"][0]["supplier"] == "원두 로스터리 가"
    assert "supplier_id" not in named["quotes"][0]
    assert current["quotes"][0]["supplier_id"] == "R1"  # 원본은 그대로
    assert _named_suppliers({"operation_form": {}}) == {"operation_form": {}}
    # 번호가 글자가 아니면 바꾸지 않고 그대로 둔다(오류 없이)
    odd = {"quotes": [{"supplier_id": ["R1"]}], "suppliers": [{"supplier_id": {"x": 1}, "supplier_name": "가"}]}
    assert _named_suppliers(odd)["quotes"][0] == {"supplier_id": ["R1"]}
