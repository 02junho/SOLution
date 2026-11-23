"""운영 실험 대화 입력: 폼 값 읽기·검사.

운영 입력(work_version.input_json)은 폼 값만 담는다({"operation_form": {...}}, 화면 폼과 같은 모양).
근무표 세 안은 계산할 때 Spring OperationInputBuilder가 만든다(빌더는 그것 하나다).
말하지 않은 선택 칸(라스트 오더 등)은 비워 두고, 계산할 때 기본값을 쓴다.
바쁜 시간은 입력이 아니다: 상권 데이터에서 손님이 가장 몰리는 시간대(Spring OperationInputBuilder.PEAK_START~PEAK_END)를 쓴다.

대화 흐름
- 처음 입력: 사장님이 자유롭게 말한 값을 LLM이 읽어 저장하고, 빠진 필수 값(하루 주문 → 사장님 근무 → 직원 시급)만 묻는다.
  방금 물은 칸은 LLM 요약에 함께 넣어("방금 물은 칸"), "네"·"최저" 같은 짧은 답도 LLM이 그 질문의 답으로 읽는다.
  필수 값이 다 모이기 전에는 계산할 수 없다(Spring이 입력 필요로 막는다).
- 수정: 저장된 폼 값을 바꾼다.
값을 읽는 일은 LLM이 하고, 이 모듈은 형식 맞추기와 폼과 같은 검사만 한다:
하루 주문 1~300건, 라스트 오더 마감 30분 전~마감(기본 18:30~19:00), 시급은 그해 최저시급 이상, 처리시간 1~300초.

가게 데이터 버전 칸(open_time·close_time·menu_cups·manufacture_sec_by_menu·orders_by_slot·peak_*·store_source)은
폼(파일 불러오기)에서만 넣고 대화는 그대로 둔다. 하루 주문 수는 시간대별 주문(orders_by_slot) 합계,
없으면 메뉴별 잔 수(menu_cups) 합계다(Spring이 같은 순서로 계산한다).
"""

from __future__ import annotations

import math
from datetime import date, datetime, time
from decimal import Decimal
from zoneinfo import ZoneInfo

from app.tools.labor.policies import MINIMUM_WAGES

SEOUL = ZoneInfo("Asia/Seoul")
MAX_DAILY_ORDERS = 300
DAY_START = "07:00"
DAY_END = "19:00"
DEFAULT_LAST_ORDER = "18:45"  # 기본 영업시간(07:00~19:00)일 때의 값. 마감이 다르면 마감 LAST_ORDER_GAP_MIN분 전
LAST_ORDER_GAP_MIN = 15
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

# 화면(입력 확인 카드)에 보이는 값 표기. LLM 요약에 넣어, 사장님이 화면 표기 그대로 말해도 뜻으로 읽게 한다.
# 문장 예시를 늘리지 않고 이 표 하나만 고친다. 화면 문구와 같은지는 테스트로 확인한다(OperationInputReview.tsx).
VALUE_LABELS: dict[str, dict[int, str]] = {
    "is_owner_working": {1: "사장님 + 직원 1명", 0: "직원 2명"},
}

# 대화로는 바꾸지 않는 칸과 안내 문구.
FORM_ONLY: dict[str, str] = {
    "staff_count": "인원은 비교 안에 이미 들어 있어요. '한 명 추가' 안이 바쁜 시간에 1명을 더한 결과예요. "
    "사장님 없이 직원 2명이 일하면 '사장님은 안 나와요'라고 말해 주세요.",
    "open_time": "영업시간은 '폼으로 직접 입력'에서 바꿔 주세요.",
    "close_time": "영업시간은 '폼으로 직접 입력'에서 바꿔 주세요. 라스트 오더는 마감 30분 전부터 마감 사이로 바꿀 수 있어요.",
    "repeat_count": "반복 횟수는 30회로 고정해서 비교해요.",
    "staff_start_time": "직원 근무시간은 오픈부터 마감까지로 정해서 비교해요.",
    "staff_end_time": "직원 근무시간은 오픈부터 마감까지로 정해서 비교해요.",
    "selected_menu_ids": "메뉴는 기본 5종으로 비교해요. 판매 비중은 '폼으로 직접 입력'에서 바꿔 주세요.",
    "menu_weights": "판매 비중은 '폼으로 직접 입력'에서 바꿔 주세요.",
    "rush_start_time": "바쁜 시간은 가게 데이터 파일을 불러오면 주문이 가장 몰리는 시간으로 정해지고, "
    f"확인 화면에서 고칠 수 있어요. 파일이 없으면 상권 데이터의 {int(PEAK[0][:2])}~{int(PEAK[1][:2])}시를 써요.",
}
FORM_ONLY["rush_end_time"] = FORM_ONLY["rush_start_time"]

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


def cups_total(values: dict) -> int | None:
    """가게 데이터의 하루 주문 수: 시간대별 주문 합계, 없으면 메뉴별 잔 수 합계. 둘 다 없으면 None."""
    for key in ("orders_by_slot", "menu_cups"):
        counts = values.get(key)
        if isinstance(counts, dict) and counts:
            return sum(int(v) for v in counts.values() if isinstance(v, (int, float)))
    return None


def peak(values: dict) -> tuple[str, str]:
    return values.get("peak_start_time") or PEAK[0], values.get("peak_end_time") or PEAK[1]


def _slot_hours(values: dict) -> tuple[str, str] | None:
    slots = values.get("orders_by_slot")
    if not isinstance(slots, dict) or not slots:
        return None
    spans = sorted(k.split("-") for k in slots if isinstance(k, str) and "-" in k)
    return (spans[0][0], spans[-1][1]) if spans else None


def hours(values: dict) -> tuple[str, str]:
    """폼의 영업시간: 시간대별 주문의 처음·끝, 없으면 open_time·close_time, 없으면 07:00~19:00."""
    return _slot_hours(values) or (values.get("open_time") or DAY_START, values.get("close_time") or DAY_END)


def _minus(hhmm: str, minutes: int) -> str:
    total = int(hhmm[:2]) * 60 + int(hhmm[3:]) - minutes
    return f"{total // 60:02d}:{total % 60:02d}"


def _filled(values: dict, key: str) -> bool:
    if key == "daily_orders" and cups_total(values) is not None:
        return True
    return values.get(key) is not None


def is_complete(values: dict) -> bool:
    """필수 값(하루 주문·사장님 근무·시급)이 다 있는지. 다 있어야 계산할 수 있다."""
    return all(_filled(values, key) for key in REQUIRED)


def next_missing(values: dict) -> tuple[int, str, str, list[str], str] | None:
    """처음 입력에서 아직 빠진 필수 값(순번, 칸, 질문, 선택지, 칸 이름). 다 있으면 None."""
    for step, (key, text, choices, label) in enumerate(GUIDED, start=1):
        if not _filled(values, key):
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


def pending_question(values: dict, asked: str | None = None, asked_text: str | None = None) -> dict | None:
    """지금 묻고 있는 칸(LLM이 짧은 답을 그 질문의 답으로 읽게 요약에 넣는다).

    실제로 발급한 질문의 칸(asked)이 있으면 그 칸을 쓰고, 없으면 처음 입력 순서의 다음 빈 칸. 둘 다 없으면 None.
    """
    guided = next((g for g in GUIDED if g[0] == asked), None) if asked in FIELDS else None
    if guided is not None:
        key, text, choices, label = guided
        choices = guided_choices(key, choices)
    elif asked in FIELDS:
        key, text, choices, label = asked, None, [], FIELDS[asked]
    else:
        missing = next_missing(values)
        if missing is None:
            return None
        _, key, text, choices, label = missing
    question = {"target": key, "질문": asked_text or text, "칸 설명": label}
    if choices:
        question["예시 답"] = choices
    if key == "hourly_wage_krw":
        minimum = MINIMUM_WAGES.get(_year(values))
        if minimum is not None:
            question["최저시급"] = int(minimum)
    return question


def summary(current: dict | None) -> dict:
    """LLM에 줄 작은 요약. 지금 폼 값과, 비어 있으면 계산에 쓰는 기본값."""
    values = form_values(current)
    open_time, close_time = hours(values)
    cups = cups_total(values)
    out = {
        "daily_orders": cups if cups is not None else values.get("daily_orders"),
        "last_order_time": values.get(
            "last_order_time", f"{_minus(close_time, LAST_ORDER_GAP_MIN)}(기본)"
        ),
        "is_owner_working": values.get("is_owner_working"),
        "hourly_wage_krw": values.get("hourly_wage_krw"),
        "order_time_sec": values.get("order_time_sec", 60),
        "handoff_time_sec": values.get("handoff_time_sec", 30),
        "fixed": f"영업 {open_time}~{close_time}, 일하는 사람 2명이 영업시간 내내 근무, "
        f"바쁜 시간 {peak(values)[0]}~{peak(values)[1]}"
        f"({'가게 데이터' if values.get('peak_start_time') else '상권 데이터'}), 30회 반복"
        f", 에스프레소 머신 {values.get('espresso_machines', 1)}대·블렌더 {values.get('blenders', 1)}대"
        f", 목표 대기 주문 후 {values.get('target_wait_sec', 300) // 60}분(10명 중 9명)",
    }
    if cups is not None:
        out["store_data"] = (
            "가게 데이터 파일로 넣음(하루 주문 = 시간대별 주문 합계 또는 잔 수 합계, 폼에서만 바꿈)"
        )
    return out


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
    cups = cups_total(values)
    if target == "daily_orders" and cups is not None and value != cups:
        return (
            f"가게 데이터가 들어 있어서 하루 주문은 데이터 합계({cups}건)로 계산해요. "
            "바꾸려면 가게 데이터를 다시 불러와 주세요."
        )
    if target == "daily_orders" and not 1 <= value <= MAX_DAILY_ORDERS:
        return f"하루 주문은 1~{MAX_DAILY_ORDERS}건으로 알려 주세요."
    close_time = hours(values)[1]
    earliest = _minus(close_time, 30)
    if target == "last_order_time" and not earliest <= value <= close_time:
        return f"라스트 오더는 {earliest}~{close_time} 사이로 알려 주세요."
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


def default_notes(values: dict) -> list[str]:
    """비워 둔 선택 칸 중 계산할 때 기본값을 쓰는 것. 사장님께 알릴 문장."""
    notes = []
    if values.get("last_order_time") is None:
        # 요약(위)과 같은 규칙: 바뀐 마감에 맞춘다(기본 마감 19:00이면 18:45).
        notes.append(f"라스트 오더는 기본 {_minus(hours(values)[1], LAST_ORDER_GAP_MIN)}")
    return notes
