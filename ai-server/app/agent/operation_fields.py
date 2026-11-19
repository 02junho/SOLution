"""운영 실험 대화 입력: 폼 값 읽기·검사.

운영 입력(work_version.input_json)은 폼 값만 담는다({"operation_form": {...}}, 화면 폼과 같은 모양).
근무표 세 안은 계산할 때 Spring OperationInputBuilder가 만든다(빌더는 그것 하나다).
말하지 않은 선택 칸(라스트 오더 등)은 비워 두고, 계산할 때 기본값을 쓴다.
바쁜 시간은 입력이 아니다: 상권 데이터에서 손님이 가장 몰리는 시간대(Spring OperationInputBuilder.PEAK_START~PEAK_END)를 쓴다.

대화 흐름
- 처음 입력: 말할 때마다 지금까지의 폼 값을 저장하고, 하루 주문 수 → 사장님 근무 → 직원 시급 중 빠진 값을 묻는다.
  필수 값이 다 모이기 전에는 계산할 수 없다(Spring이 입력 필요로 막는다).
- 수정: 저장된 폼 값을 바꾼다.
검사 기준은 폼과 같다: 하루 주문 1~300건, 라스트 오더 18:30~19:00, 시급은 그해 최저시급 이상, 처리시간 1~300초.
"""

from __future__ import annotations

import math
import re
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from app.tools.labor.policies import MINIMUM_WAGES

SEOUL = ZoneInfo("Asia/Seoul")
MAX_DAILY_ORDERS = 300
DAY_END = "19:00"
DEFAULT_LAST_ORDER = "18:45"
# 상권 데이터에서 손님이 가장 몰리는 시간대(Spring OperationInputBuilder.PEAK_START~PEAK_END). 안내 문장에만 쓴다.
PEAK = ("11:00", "14:00")

# 대화로 바꿀 수 있는 폼 값: target → 사람이 읽는 이름
FIELDS: dict[str, str] = {
    "daily_orders": "하루 주문 건수",
    "last_order_time": "라스트 오더",
    "is_owner_working": "사장님 근무 여부",
    "hourly_wage_krw": "직원 시급",
    "order_time_sec": "주문·결제 평균 시간",
    "handoff_time_sec": "음료 전달 평균 시간",
}
INTEGER_FIELDS = {
    "daily_orders",
    "hourly_wage_krw",
    "order_time_sec",
    "handoff_time_sec",
}
TIME_FIELDS = {"last_order_time"}
REQUIRED = ("daily_orders", "is_owner_working", "hourly_wage_krw")
# 대화로 처음 입력할 때 순서대로 묻는 칸(질문, 선택지, 카드에 보일 칸 이름). 나머지는 비워 두고 계산할 때 기본값을 쓴다.
GUIDED: list[tuple[str, str, list[str], str]] = [
    (
        "daily_orders",
        "하루에 주문이 몇 건 정도 들어오나요?",
        ["60건", "100건", "150건", "276건 (상권 평균)"],
        "하루 주문 건수 · 1~300건, 숫자만 적어도 돼요",
    ),
    (
        "is_owner_working",
        "사장님도 매장에서 직접 일하시나요?",
        ["네, 같이 일해요", "아니요, 직원만 일해요"],
        "사장님 근무 여부 · 일하시면 사장님 근무는 인건비에서 빠져요",
    ),
    (
        "hourly_wage_krw",
        "직원 시급은 얼마인가요?",
        [],
        "직원 시급 · 최저시급 이상, 예) 11000",
    ),
]

# 대화로는 바꾸지 않는 칸과 안내 문구.
FORM_ONLY: dict[str, str] = {
    "staff_count": "인원은 비교 안에 이미 들어 있어요. '한 명 추가' 안이 바쁜 시간에 1명을 더한 결과예요.",
    "open_time": "영업시간은 07~19시로 고정해서 비교해요.",
    "close_time": "영업시간은 07~19시로 고정해서 비교해요. 마감은 라스트 오더(18:30~19:00)로 바꿀 수 있어요.",
    "repeat_count": "반복 횟수는 30회로 고정해서 비교해요.",
    "staff_start_time": "직원 근무시간은 07~19시로 고정해서 비교해요.",
    "staff_end_time": "직원 근무시간은 07~19시로 고정해서 비교해요.",
    "selected_menu_ids": "메뉴는 기본 5종으로 비교해요. 판매 비중은 '폼으로 직접 입력'에서 바꿔 주세요.",
    "menu_weights": "판매 비중은 '폼으로 직접 입력'에서 바꿔 주세요.",
    "rush_start_time": f"바쁜 시간은 상권 데이터에서 손님이 가장 몰리는 {PEAK[0]}~{PEAK[1]}로 정해져 있어요. "
    "우리 매장만의 바쁜 시간 반영은 다음 단계 기능이에요.",
}
FORM_ONLY["rush_end_time"] = FORM_ONLY["rush_start_time"]

_YES_WORDS = {
    "네",
    "넵",
    "넹",
    "예",
    "응",
    "어",
    "웅",
    "엉",
    "그래",
    "그럼요",
    "같이",
    "일해요",
    "일해",
}
_TRUE = {"1", "true", "yes", "y", "예", "네", "응", "일함", "근무"}
_FALSE = {"0", "false", "no", "n", "아니오", "아니요", "아니", "안함", "안 함", "쉼"}


def _obj(value) -> dict:
    return value if isinstance(value, dict) else {}


def today() -> date:
    return datetime.now(SEOUL).date()


DRAFT_KEY = "operation_form"


def form_values(current: dict | None) -> dict:
    """저장 입력의 폼 값. 비어 있으면 {}. 이 구조 전에 저장된 완성본(simulation·labor)이면 폼 값으로 되읽는다."""
    current = _obj(current)
    form = current.get(DRAFT_KEY)
    if isinstance(form, dict):
        return dict(form)
    if isinstance(_obj(current.get("labor")).get("workers"), list):
        return _legacy_values(current)
    return {}


def is_complete(values: dict) -> bool:
    """필수 값(하루 주문·사장님 근무·시급)이 다 있는지. 다 있어야 계산할 수 있다."""
    return all(values.get(key) is not None for key in REQUIRED)


def next_missing(values: dict) -> tuple[int, str, str, list[str], str] | None:
    """처음 입력에서 아직 빠진 필수 값(순번, 칸, 질문, 선택지, 칸 이름). 다 있으면 None."""
    for step, (key, text, choices, label) in enumerate(GUIDED, start=1):
        if values.get(key) is None:
            return step, key, text, guided_choices(key, choices), label
    return None


def _legacy_values(current: dict) -> dict:
    """예전 완성본(근무표까지 든 입력)에서 폼 값만 되읽는다. 시연 DB를 새로 만들면 필요 없어진다."""
    simulation = _obj(current.get("simulation"))
    scenario = _obj(simulation.get("scenario"))
    workers = [w for w in _obj(current.get("labor")).get("workers", []) if isinstance(w, dict)]
    staff = [w for w in workers if not w.get("is_owner")]
    values = {
        "business_date": current.get("business_date"),
        "daily_orders": scenario.get("daily_orders"),
        "last_order_time": scenario.get("last_order_time"),
        "is_owner_working": any(w.get("is_owner") for w in workers),
        "hourly_wage_krw": next(
            (w.get("hourly_wage_krw") for w in staff if w.get("hourly_wage_krw") is not None), None
        ),
        "is_staff_minor": next((w.get("is_minor") for w in staff if w.get("is_minor") is not None), None),
    }
    for key in ("selected_menu_ids", "menu_weights", "order_time_sec", "handoff_time_sec"):
        if key in simulation:
            values[key] = simulation[key]
    return {key: value for key, value in values.items() if value is not None}


def summary(current: dict | None) -> dict:
    """LLM에 줄 작은 요약. 지금 폼 값과, 비어 있으면 계산에 쓰는 기본값."""
    values = form_values(current)
    return {
        "daily_orders": values.get("daily_orders"),
        "last_order_time": values.get("last_order_time", f"{DEFAULT_LAST_ORDER}(기본)"),
        "is_owner_working": values.get("is_owner_working"),
        "hourly_wage_krw": values.get("hourly_wage_krw"),
        "order_time_sec": values.get("order_time_sec", 60),
        "handoff_time_sec": values.get("handoff_time_sec", 30),
        "fixed": f"영업 07~19시, 직원 2명 07~19시, 바쁜 시간 {PEAK[0]}~{PEAK[1]}(상권 데이터), 30회 반복",
    }


# ---------------------------------------------------------------- 값 검사
def _year(values: dict) -> int:
    text = values.get("business_date")
    return date.fromisoformat(text).year if isinstance(text, str) else today().year


def normalize(target: str, value):
    """LLM이 준 값을 폼 값 형식으로 맞춘다. 맞출 수 없으면 ValueError."""
    if target == "is_owner_working":
        if isinstance(value, (int, float)) and value in (0, 1):
            return bool(value)
        text = str(value).strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
        raise ValueError
    if target in TIME_FIELDS:
        parsed = time.fromisoformat(str(value).strip())
        if parsed.second or parsed.microsecond:
            raise ValueError
        return parsed.strftime("%H:%M")
    if target in INTEGER_FIELDS:
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not math.isfinite(value)
            or value != int(value)
        ):
            raise ValueError
        return int(value)
    raise ValueError


def check(values: dict, target: str) -> str | None:
    """한 칸이 폼 기준을 지키는지. 문제가 있으면 사장님께 보일 문장."""
    value = values.get(target)
    if target == "daily_orders" and not 1 <= value <= MAX_DAILY_ORDERS:
        return f"하루 주문은 1~{MAX_DAILY_ORDERS}건으로 알려 주세요."
    if target == "last_order_time" and not "18:30" <= value <= DAY_END:
        return "라스트 오더는 18:30~19:00 사이로 알려 주세요."
    if target == "hourly_wage_krw":
        year = _year(values)
        minimum = MINIMUM_WAGES.get(year)
        if minimum is None:
            return (
                f"{year}년 최저시급 기준이 아직 없어요. 폼에서 영업일을 확인해 주세요."
            )
        if value > 1_000_000:
            return "직원 시급을 다시 확인해 주세요."
        if Decimal(value) < minimum:
            return f"직원 시급은 {year}년 최저시급({int(minimum):,}원) 이상이어야 해요."
    if target in {"order_time_sec", "handoff_time_sec"} and not 1 <= value <= 300:
        return f"{FIELDS[target]}은 1~300초로 알려 주세요."
    return None


def check_all(values: dict) -> tuple[str, str] | None:
    """칸 사이 규칙까지 본다. 문제가 있으면 (칸, 문장)."""
    for target in FIELDS:
        if values.get(target) is not None:
            problem = check(values, target)
            if problem:
                return target, problem
    return None


def guided_choices(key: str, choices: list[str]) -> list[str]:
    if key == "hourly_wage_krw":
        minimum = MINIMUM_WAGES.get(today().year)
        return [f"최저시급 {int(minimum):,}원"] if minimum is not None else []
    return choices


def parse_answer(key: str, answer) -> object | None:
    """순서 질문의 답을 LLM 없이 읽는다(선택지 버튼·숫자만 적은 답). 못 읽으면 None → LLM 해석으로 넘긴다."""
    text = str(answer or "").strip()
    if not text:
        return None
    if key == "is_owner_working":
        if any(word in text for word in ("아니", "안 해", "안해", "안 나", "안나")):
            return 0
        # "직원만 일하면 어때?"처럼 묻는 말은 답으로 확정하지 않는다(LLM 해석으로 넘김).
        # "직원 둘이 같이 일해요"처럼 직원만 일한다는 말도 사장님 근무로 읽지 않는다.
        if re.search(r"직원\s*(만|끼리|둘|들만|들끼리)", text):
            return None
        # "어떻게…", "예를 들면…"처럼 같은 글자로 시작하는 다른 말은 답으로 읽지 않는다(첫 낱말 전체로 본다).
        first = re.split(r"[\s,.!~]+", text, maxsplit=1)[0]
        if first in _YES_WORDS or text.startswith("일해") or "같이 일" in text:
            return 1
        return None
    if key == "hourly_wage_krw" and "최저" in text:
        # "최저 말고 12000원", "최저보다 높게"처럼 다른 금액·거절이 섞이면 확정하지 않는다.
        if re.search(r"\d|아니|말고|싫|보다|넘게|이상|높게|올려", text):
            return None
        minimum = MINIMUM_WAGES.get(today().year)
        return int(minimum) if minimum is not None else None
    if "만" in text or "천" in text:
        return None
    # 부호까지 읽어 음수는 범위 검사에서 걸러지게 한다("-20" → -20, "20건" → 20).
    digits = re.findall(r"-?\d[\d,]*", text)
    if len(digits) != 1:
        return None
    return int(digits[0].replace(",", ""))


def default_notes(values: dict) -> list[str]:
    """비워 둔 선택 칸 중 계산할 때 기본값을 쓰는 것. 사장님께 알릴 문장."""
    notes = []
    if values.get("last_order_time") is None:
        notes.append(f"라스트 오더는 기본 {DEFAULT_LAST_ORDER}")
    return notes
