"""결과 설명(HW-F08). 숫자·핵심 비교·경고는 템플릿이 담당하고 LLM은 문장을 다듬는다."""

from __future__ import annotations

from copy import deepcopy
from decimal import Decimal, InvalidOperation
import json
import logging
import re
from typing import Protocol

from app.agent.privacy import sanitize
from app.agent.schemas import ExplainDraft, ExplainRequest
from app.core.config import get_settings
from app.core.response import ApiResponse
from app.core.status import ResponseStatus

logger = logging.getLogger(__name__)
_NUMBER = re.compile(r"(?<![\d.])[-+]?(?:\d(?:\d|,(?=\d))*(?:\.\d+)?|\.\d+)(?:[eE][-+]?\d+)?(?![\d.])")
_GROUPED = re.compile(r"[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?(?:[eE][-+]?\d+)?\Z")
_UNSAFE = re.compile(r"발주|결제|주문|(?:구매|구입).{0,12}(?:하세요|하십시오|추천|권장)|보장|반드시.{0,12}(?:감소|증가|개선|절감)")
_SCALED = re.compile(r"\d\s*(?:십|백|천|만|억|조)")
_SPELLED = re.compile(r"[일이삼사오육칠팔구십백천만억조]+\s*(?:원|회|퍼센트)|(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열)\s*(?:번|명|개)")
_SIMULATION = "모의 조건에 따른 시뮬레이션 결과이며 실제 효과를 보장하지 않습니다."
# 매입은 견적으로 푼 최적화라 모의 조건·시뮬레이션 안내가 맞지 않는다.
_SIMULATION_WORDS = re.compile(r"모의\s*조건|시뮬레이션")
_SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


class Explainer(Protocol):
    def explain(self, req: ExplainRequest) -> dict: ...


def run(req: ExplainRequest, explainer: Explainer) -> ApiResponse[dict]:
    if not req.result_summary:
        raise ValueError("result_summary가 필요합니다.")
    data = explainer.explain(req)
    return ApiResponse(status=ResponseStatus.OK, data=data, message=data["explanation"]["headline"])


def build_template(req: ExplainRequest) -> dict:
    choices = req.result_summary.get("choices", [])
    per_choice = []
    for choice in choices:
        parts = [choice.get("label") or choice["choice_key"]]
        if choice.get("delivery_count") is not None:
            parts.append(f"배송 {int(choice['delivery_count'])}회")
        if choice.get("total_krw") is not None:
            parts.append(_won(choice["total_krw"]))
        per_choice.append({"choice_key": choice["choice_key"], "text": " · ".join(parts)})
    headline = _headline(choices)
    if req.feature_type == "operation":
        headline = "모의 조건: " + headline
    return {
        "detail_status": "EXPLAINED", "source": "template",
        "explanation": {"headline": headline, "per_choice": per_choice,
            "warnings_echo": deepcopy(req.result_summary.get("warnings", [])),
            "caveats": [_SIMULATION] if req.feature_type == "operation" else []},
    }


def _headline(choices: list[dict]) -> str:
    priced = [c for c in choices if c.get("total_krw") is not None]
    if len(priced) >= 2:
        cheap, next_choice = sorted(priced, key=lambda c: c["total_krw"])[:2]
        difference = int(next_choice["total_krw"]) - int(cheap["total_krw"])
        label = cheap.get("label") or cheap["choice_key"]
        if difference > 0:
            return f"{label}이(가) {_won(cheap['total_krw'])}으로 가장 쌉니다(다음 안보다 {_won(difference)} 적음)."
        return f"가장 싼 두 안의 총액이 {_won(cheap['total_krw'])}으로 같습니다."
    if len(priced) == 1:
        choice = priced[0]
        return f"{choice.get('label') or choice['choice_key']}: {_won(choice['total_krw'])}."
    return "결과를 불러왔어요. 전달된 요약에 없는 수치는 설명할 수 없습니다."


class LlmExplainer:
    def __init__(self):
        self.last_call_status = "not_called"

    def explain(self, req: ExplainRequest) -> dict:
        self.last_call_status = "not_called"
        template = build_template(req)
        return self._refine(req, template) or template

    def _refine(self, req: ExplainRequest, template: dict) -> dict | None:
        settings = get_settings()
        if not settings.anthropic_api_key:
            self.last_call_status = "not_configured"
            return None
        raw = self._call(settings, req)
        parsed = _parse(raw) if isinstance(raw, str) else None
        if parsed is None:
            return None
        headline, per_choice, caveats = parsed.get("headline"), parsed.get("per_choice", []), parsed.get("caveats", [])
        if (not isinstance(headline, str) or not headline.strip() or not isinstance(per_choice, list)
                or not isinstance(caveats, list) or any(not isinstance(c, str) for c in caveats)):
            return None
        allowed = _numbers_in(template) | _numbers_in(req.result_summary)
        text = headline
        if not _safe_text(text, allowed):
            return None
        # 금액·배송 횟수는 각 안에 속한 값이어야 한다. 다른 안의 숫자를 옮겨 쓰지 않는다.
        choices = {c["choice_key"]: c for c in req.result_summary.get("choices", [])}
        amounts = {str(int(c["total_krw"])) for c in choices.values() if c.get("total_krw") is not None}
        amounts |= _unit_numbers(template["explanation"]["headline"], "원")
        if (not _unit_numbers(text, "원") <= amounts
                or not _unit_numbers(text, "%") <= _percentages(req.result_summary)):
            return None
        verified_caveats = []
        for caveat in caveats:
            if req.feature_type != "operation":
                # 모의 조건·시뮬레이션이 들어간 문장만 빼고, 같은 주의의 다른 문장은 남긴다.
                caveat = " ".join(s for s in _SENTENCE_END.split(caveat.strip()) if not _SIMULATION_WORDS.search(s))
                if not caveat:
                    continue
            if (not _safe_text(caveat, allowed)
                    or not _unit_numbers(caveat.replace("퍼센트", "%"), "%") <= _percentages(req.result_summary)):
                continue
            money = _unit_numbers(caveat, "원")
            if money:
                owners = [c for key, c in choices.items() if _mentions_choice(caveat, key)]
                if len(owners) != 1 or owners[0].get("total_krw") is None:
                    continue
                if money != {str(int(owners[0]["total_krw"]))}:
                    continue
            verified_caveats.append(caveat)
        refined = {}
        seen = set()
        for item in per_choice:
            if (not isinstance(item, dict) or not isinstance(item.get("text"), str) or not item["text"].strip()
                    or not isinstance(item.get("choice_key"), str) or item["choice_key"] not in choices
                    or item["choice_key"] in seen):
                return None
            seen.add(item["choice_key"])
            choice = choices[item["choice_key"]]
            if not _safe_text(item["text"], _numbers_in(choice)):
                return None
            expected_amount = {str(int(choice["total_krw"]))} if choice.get("total_krw") is not None else set()
            expected_delivery = {str(int(choice["delivery_count"]))} if choice.get("delivery_count") is not None else set()
            if (not _unit_numbers(item["text"], "원") <= expected_amount
                    or not _unit_numbers(item["text"], "회") <= expected_delivery
                    or not _unit_numbers(item["text"].replace("퍼센트", "%"), "%") <= _percentages(choice)):
                return None
            if (expected_amount <= _unit_numbers(item["text"], "원")
                    and expected_delivery <= _unit_numbers(item["text"], "회")):
                refined[item["choice_key"]] = sanitize(item["text"])
        if not refined and not verified_caveats:
            return None
        output = deepcopy(template)
        output["source"] = "llm"
        for item in output["explanation"]["per_choice"]:
            # 금액·배송 횟수를 각 단위와 함께 보존한 문장만 템플릿을 대체한다.
            item["text"] = refined.get(item["choice_key"], item["text"])
        output["explanation"]["caveats"] += [sanitize(c) for c in verified_caveats
            if sanitize(c) not in output["explanation"]["caveats"]]
        # 핵심 비교·숫자·경고·모의 조건은 LLM이 바꾸지 않는다.
        return output

    def _call(self, settings, req: ExplainRequest) -> str | None:
        try:
            from langchain_anthropic import ChatAnthropic
        except ImportError:  # pragma: no cover
            self.last_call_status = "unavailable"
            return None
        system = (
            "카페 계산 결과를 쉬운 한국어로 설명한다. 제공한 수치와 사실만 그대로 사용하고 "
            "원인·효과·보장을 지어내지 않는다. 발주·결제를 권하지 않는다. "
            "운영은 모의 조건임을 명시한다. 매입은 견적으로 푼 최적화이므로 모의 조건·시뮬레이션을 언급하지 않는다. 안마다 짧은 한 문장으로 설명한다. "
            "total_krw와 delivery_count가 있으면 각각 원·회 단위를 붙인 아라비아 숫자로 빠짐없이 쓴다. "
            "다른 안의 수치를 섞거나 차액·비율을 새로 계산하지 않는다. headline은 짧은 안내로 쓰고 "
            "caveats는 숫자 없는 문장이나 빈 배열로 둔다. JSON만 출력한다: "
            "{headline:string, per_choice:[{choice_key,text}], caveats:[string]}"
        )
        summary = json.dumps(sanitize(req.result_summary), ensure_ascii=False)
        if len(summary) > 6000:
            self.last_call_status = "skipped_large_input"
            return None  # 전체 대용량 결과를 모델에 넘기지 않고 템플릿으로 설명한다.
        user = "요약: " + summary
        if req.focus:
            user += "\n궁금한 점: " + sanitize(req.focus)[:1000]
        try:
            model = ChatAnthropic(model=settings.anthropic_model, api_key=settings.anthropic_api_key,
                                  max_tokens=4096, timeout=20, max_retries=0)
            response = model.with_structured_output(
                ExplainDraft, method="json_schema", include_raw=True,
            ).invoke([("system", system), ("human", user)])
            result = response["raw"]
        except Exception:
            self.last_call_status = "failed"
            logger.warning("LLM 설명 호출 실패: 템플릿으로 대체합니다.")
            return None
        stop_reason = getattr(result, "response_metadata", {}).get("stop_reason")
        if stop_reason in {"refusal", "max_tokens"}:
            self.last_call_status = "refused" if stop_reason == "refusal" else "truncated"
            return None
        # 모델 응답 수신과 최종 문장 채택(source)은 구분한다. 안전 검증은 아래 단계에서 수행한다.
        self.last_call_status = "success"
        parsed = response.get("parsed")
        if isinstance(parsed, ExplainDraft):
            return parsed.model_dump_json()
        content = result.content
        if isinstance(content, list):
            content = "".join(p["text"] for p in content if isinstance(p, dict) and isinstance(p.get("text"), str))
        return content if isinstance(content, str) else None


def get_explainer() -> Explainer:
    return LlmExplainer()


def _won(value) -> str:
    return f"{int(value):,}원"


def _canonical(raw: str) -> str:
    if len(raw) > 128:
        return "INVALID_NUMBER"
    if "," in raw and not _GROUPED.fullmatch(raw):
        return "INVALID_NUMBER"
    try:
        number = Decimal(raw.replace(",", ""))
        if not number.is_finite() or abs(number.adjusted()) > 128:
            return "INVALID_NUMBER"
        text = format(number, "f")
        return text.rstrip("0").rstrip(".") if "." in text else text
    except InvalidOperation:
        return "INVALID_NUMBER"


def _numbers(text: str) -> set[str]:
    return {_canonical(match.group()) for match in _NUMBER.finditer(text)}


def _unit_numbers(text: str, unit: str) -> set[str]:
    return {_canonical(match.group()) for match in _NUMBER.finditer(text)
            if text[match.end():].lstrip().startswith(unit)}


def _mentions_choice(text: str, key: str) -> bool:
    # 자유 문장의 별칭은 추정하지 않고 명시된 choice_key만 귀속 근거로 삼는다.
    word = r"[A-Za-z0-9_]" if key.isascii() and not key.isdecimal() else r"\w"
    return bool(re.search(r"(?<!" + word + r")" + re.escape(key) + r"(?!" + word + r")", text))


def _percentages(obj) -> set[str]:
    if isinstance(obj, dict):
        found = set()
        for key, value in obj.items():
            if key.endswith(("_pct", "_percent")) and isinstance(value, (int, float)) and not isinstance(value, bool):
                found.add(_canonical(str(value)))
            found |= _percentages(value)
        return found
    if isinstance(obj, list):
        return set().union(*(_percentages(v) for v in obj)) if obj else set()
    return _unit_numbers(obj.replace("퍼센트", "%"), "%") if isinstance(obj, str) else set()


def _safe_text(text: str, allowed: set[str]) -> bool:
    numbers = _numbers(text)
    return ("INVALID_NUMBER" not in numbers and not _UNSAFE.search(text) and not _SCALED.search(text)
            and not _SPELLED.search(text) and numbers <= allowed)


def _numbers_in(obj) -> set[str]:
    if isinstance(obj, dict):
        return set().union(*(_numbers_in(v) for v in obj.values())) if obj else set()
    if isinstance(obj, list):
        return set().union(*(_numbers_in(v) for v in obj)) if obj else set()
    if isinstance(obj, (int, float)) and not isinstance(obj, bool):
        return {_canonical(str(obj))}
    return _numbers(obj) if isinstance(obj, str) else set()


def _parse(raw: str) -> dict | None:
    text = raw.strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        data = json.loads(text[start:end + 1])
        return data if isinstance(data, dict) else None
    except json.JSONDecodeError:
        return None
