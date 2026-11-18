"""운영 실험 대화 입력: 폼 값 읽기·검사·운영 입력(근무표 포함) 만들기.

운영 입력(work_version.input_json)은 폼 값으로 만든 완성본이다(simulation 설정 + labor 근무표 세 안).
폼에서는 Spring OperationInputBuilder가, 대화에서는 이 모듈의 build()가 같은 규칙으로 만든다.

⚠️ 두 빌더는 같은 기준 파일(data/demo/operation/input_builder_cases.json)과 비교하는 테스트로 묶여 있다.
   Spring: OperationInputBuilderCasesTest / Python: tests/test_agent_operation.py
   빌더 규칙을 바꿀 때는 ① Spring 빌더 → ② 기준 파일 다시 뽑기(Spring 테스트 주석 참고) → ③ 이 build()까지 같이 고친다.

대화 흐름
- 처음 입력(매입처럼 저장하면서 채우기): 말할 때마다 지금까지의 폼 값만 "작성 중 입력"({"operation_form": {...}})으로
  저장하고, 하루 주문 수 → 사장님 근무 → 직원 시급 중 빠진 값을 말풍선으로 묻는다. 셋이 다 모이면 라스트 오더·바쁜 시간
  등은 기본값으로 채워 완성본으로 저장하고 알려 준다. 작성 중 입력은 계산할 수 없다(Spring이 입력 필요로 막는다).
- 수정: 저장된 완성본에서 폼 값을 읽어 바꾼 뒤 다시 만든다(사장님 근무·바쁜 시간도 대화로 바꿀 수 있다).
검사 기준은 폼과 같다: 하루 주문 1~300건, 라스트 오더 18:30~19:00, 시급은 그해 최저시급 이상,
바쁜 시간 07~19시 안·끝이 시작보다 늦게, 처리시간 1~300초.
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
DAY_START, DAY_END = "07:00", "19:00"
DEFAULT_LAST_ORDER = "18:45"
DEFAULT_RUSH = ("11:00", "14:00")
ASSUMPTIONS_VERSION = "operation.v1"

# 대화로 바꿀 수 있는 폼 값: target → 사람이 읽는 이름
FIELDS: dict[str, str] = {
    "daily_orders": "하루 주문 건수",
    "last_order_time": "라스트 오더",
    "is_owner_working": "사장님 근무 여부",
    "hourly_wage_krw": "직원 시급",
    "rush_start_time": "바쁜 시간 시작",
    "rush_end_time": "바쁜 시간 끝",
    "order_time_sec": "주문·결제 평균 시간",
    "handoff_time_sec": "음료 전달 평균 시간",
}
INTEGER_FIELDS = {
    "daily_orders",
    "hourly_wage_krw",
    "order_time_sec",
    "handoff_time_sec",
}
TIME_FIELDS = {"last_order_time", "rush_start_time", "rush_end_time"}
# 대화로 처음 입력할 때 순서대로 묻는 칸(질문, 선택지, 카드에 보일 칸 이름). 나머지는 기본값으로 채우고 알려 준다.
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
}

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


def draft_values(current: dict | None) -> dict | None:
    """작성 중 입력이면 지금까지 채운 폼 값, 아니면 None."""
    form = _obj(current).get(DRAFT_KEY)
    return dict(form) if isinstance(form, dict) else None


def next_missing(values: dict) -> tuple[int, str, str, list[str], str] | None:
    """처음 입력에서 아직 빠진 필수 값(순번, 칸, 질문, 선택지, 칸 이름). 다 있으면 None."""
    for step, (key, text, choices, label) in enumerate(GUIDED, start=1):
        if values.get(key) is None:
            return step, key, text, guided_choices(key, choices), label
    return None


def is_operation_input(current: dict | None) -> bool:
    """운영 입력 완성본 모양(simulation.scenario + labor.workers)인지."""
    current = _obj(current)
    return isinstance(
        _obj(current.get("simulation")).get("scenario"), dict
    ) and isinstance(_obj(current.get("labor")).get("workers"), list)


# ---------------------------------------------------------------- 완성본 → 폼 값
def read_values(current: dict) -> dict:
    """저장된 완성본에서 폼 값을 되읽는다. 없는 선택 칸은 넣지 않아 다시 만들어도 모양이 같다."""
    simulation = _obj(current.get("simulation"))
    scenario = _obj(simulation.get("scenario"))
    labor = _obj(current.get("labor"))
    workers = [w for w in labor.get("workers", []) if isinstance(w, dict)]
    staff = [w for w in workers if not w.get("is_owner")]
    window = next(
        (w for w in labor.get("avoid_break_windows") or [] if isinstance(w, dict)), {}
    )
    values = {
        "business_date": current.get("business_date"),
        "daily_orders": scenario.get("daily_orders"),
        "last_order_time": scenario.get("last_order_time", DEFAULT_LAST_ORDER),
        "is_owner_working": any(w.get("is_owner") for w in workers),
        "hourly_wage_krw": next(
            (
                w.get("hourly_wage_krw")
                for w in staff
                if w.get("hourly_wage_krw") is not None
            ),
            None,
        ),
        "is_staff_minor": next(
            (w.get("is_minor") for w in staff if w.get("is_minor") is not None), None
        ),
        "rush_start_time": window.get("start_time", DEFAULT_RUSH[0]),
        "rush_end_time": window.get("end_time", DEFAULT_RUSH[1]),
    }
    for key in (
        "selected_menu_ids",
        "menu_weights",
        "order_time_sec",
        "handoff_time_sec",
    ):
        if key in simulation:
            values[key] = simulation[key]
    return values


def summary(current: dict | None) -> dict:
    """LLM에 줄 작은 요약. 근무표 전체 대신 대화로 바꿀 수 있는 지금 값만 담는다."""
    values = read_values(_obj(current))
    return {
        "daily_orders": values["daily_orders"],
        "last_order_time": values["last_order_time"],
        "is_owner_working": values["is_owner_working"],
        "hourly_wage_krw": values["hourly_wage_krw"],
        "rush": f"{values['rush_start_time']}~{values['rush_end_time']}",
        "order_time_sec": values.get("order_time_sec", 60),
        "handoff_time_sec": values.get("handoff_time_sec", 30),
        "fixed": "영업 07~19시, 직원 2명 07~19시, 30회 반복",
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
    if (
        target in {"rush_start_time", "rush_end_time"}
        and not DAY_START <= value <= DAY_END
    ):
        return "바쁜 시간은 07:00~19:00 안에서 알려 주세요."
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
    if values["rush_start_time"] >= values["rush_end_time"]:
        return "rush_end_time", "바쁜 시간 끝은 시작보다 늦게 알려 주세요."
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


def fill_defaults(values: dict) -> list[str]:
    """처음 입력에서 말하지 않은 칸을 기본값으로 채우고, 채운 내용을 사장님께 알릴 문장으로 돌려준다."""
    notes = []
    if not values.get("business_date"):
        values["business_date"] = today().isoformat()
    if values.get("is_owner_working") is None:
        values["is_owner_working"] = True
        notes.append("사장님도 일하는 것으로")
    if values.get("hourly_wage_krw") is None:
        minimum = MINIMUM_WAGES.get(_year(values))
        if minimum is not None:
            values["hourly_wage_krw"] = int(minimum)
            notes.append(f"직원 시급은 최저시급 {int(minimum):,}원으로")
    if values.get("last_order_time") is None:
        values["last_order_time"] = DEFAULT_LAST_ORDER
        notes.append(f"라스트 오더는 {DEFAULT_LAST_ORDER}로")
    if values.get("rush_start_time") is None and values.get("rush_end_time") is None:
        values["rush_start_time"], values["rush_end_time"] = DEFAULT_RUSH
        notes.append("바쁜 시간은 11:00~14:00으로")
    if values.get("rush_start_time") is None:
        values["rush_start_time"] = DEFAULT_RUSH[0]
        notes.append(f"바쁜 시간 시작은 {DEFAULT_RUSH[0]}으로")
    if values.get("rush_end_time") is None:
        values["rush_end_time"] = DEFAULT_RUSH[1]
        notes.append(f"바쁜 시간 끝은 {DEFAULT_RUSH[1]}으로")
    return notes


# ---------------------------------------------------------------- 폼 값 → 완성본 (Spring OperationInputBuilder와 같은 규칙)
def _shift(worker: str, start: str, end: str, task: str) -> dict:
    return {
        "worker_key": worker,
        "start_time": start,
        "end_time": end,
        "task_code": task,
        "breaks": [],
    }


def _help_in_rush(
    worker: str, task: str, help_task: str, start: str, end: str
) -> list[dict]:
    shifts = [_shift(worker, DAY_START, start, task)] if DAY_START < start else []
    shifts.append(_shift(worker, start, end, help_task))
    if end < DAY_END:
        shifts.append(_shift(worker, end, DAY_END, task))
    return shifts


def build(values: dict) -> dict:
    """검사를 마친 폼 값으로 운영 입력 완성본을 만든다."""
    business_date = date.fromisoformat(values["business_date"])
    owner = bool(values["is_owner_working"])
    minor = bool(values.get("is_staff_minor"))
    wage = int(values["hourly_wage_krw"])
    start, end = values["rush_start_time"], values["rush_end_time"]
    lead, maker, extra = (
        ("OWNER", "STAFF_1", "STAFF_2") if owner else ("STAFF_1", "STAFF_2", "STAFF_3")
    )

    def worker(key, is_owner, is_minor, hourly):
        return {
            "worker_key": key,
            "is_owner": is_owner,
            "is_minor": is_minor,
            "hourly_wage_krw": hourly,
        }

    workers = [
        worker(lead, owner, None if owner else minor, None if owner else wage),
        worker(maker, False, minor, wage),
        worker(extra, False, minor, wage),
    ]
    plans = [
        {
            "choice_key": "CURRENT",
            "shifts": [
                _shift(lead, DAY_START, DAY_END, "ORDER_HANDOFF"),
                _shift(maker, DAY_START, DAY_END, "PREPARATION"),
            ],
        },
        {
            "choice_key": "ALT_A",
            "shifts": _help_in_rush(
                lead, "ORDER_HANDOFF", "ORDER_HANDOFF_HELP_PREPARATION", start, end
            )
            + _help_in_rush(
                maker, "PREPARATION", "PREPARATION_HELP_ORDER_HANDOFF", start, end
            ),
        },
        {
            "choice_key": "ALT_C",
            "shifts": [
                _shift(lead, DAY_START, DAY_END, "ORDER_HANDOFF"),
                _shift(maker, DAY_START, DAY_END, "PREPARATION"),
                _shift(extra, start, end, "PREPARATION_HELP_ORDER_HANDOFF"),
            ],
        },
    ]
    simulation = {
        "scenario": {
            "daily_orders": int(values["daily_orders"]),
            "last_order_time": values["last_order_time"],
            "share_method": "p50",
            "takeout_ratio": 0.4,
        },
        "repetitions": 30,
        "random_seed": 42,
        "execution_mode": "continuous_day",
        "include_events": True,
    }
    if values.get("selected_menu_ids"):
        simulation["selected_menu_ids"] = sorted(set(values["selected_menu_ids"]))
    if values.get("menu_weights"):
        simulation["menu_weights"] = {
            key: values["menu_weights"][key] for key in sorted(values["menu_weights"])
        }
    for key in ("order_time_sec", "handoff_time_sec"):
        if values.get(key) is not None:
            simulation[key] = int(values[key])
    return {
        "business_date": business_date.isoformat(),
        "wage_year": business_date.year,
        "assumptions_version": ASSUMPTIONS_VERSION,
        "simulation": simulation,
        "labor": {
            "timezone": "Asia/Seoul",
            "rule_policy_version": f"labor.kr.{business_date.year}.v1",
            "auto_break": True,
            "avoid_break_windows": [{"start_time": start, "end_time": end}],
            "workers": workers,
            "plans": plans,
            "cost_options": {
                "include_weekly_holiday": False,
                "include_employer_insurance": False,
            },
        },
    }
