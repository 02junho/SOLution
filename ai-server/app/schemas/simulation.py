"""Public API input models for Swagger and team snake_case conventions."""

from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field, ConfigDict, model_validator


class SimulationScenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    area: Literal["을지로입구역"] = "을지로입구역"
    share_method: Literal["p50", "latest", "quarter"] = "p50"
    quarter: str | None = None
    # 영업시간(day_window에서 확인). 비우면 07:00~19:00, 가게 시간대별 주문이 있으면 그 처음·끝.
    start_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    # 비우면 마감 15분 전.
    last_order_time: str | None = None
    daily_orders: int | None = Field(default=None, ge=0, le=5000)
    # 시간대별 주문 수. 상권 네 칸 이름이거나, 가게 데이터의 이어진 시간대(예: 1시간 단위).
    orders_by_slot: dict[str, int] | None = None
    demand_level: Literal["low", "medium", "high"] | None = None
    takeout_ratio: float = Field(default=0.4, ge=0, le=1)
    # 바쁜 시간(서로 돕기·한 명 추가가 바뀌는 구간). 비우면 11:00~14:00. 시간대 경계에 맞춘다.
    peak_start_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    peak_end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")

    @model_validator(mode="after")
    def _last_order_default(self):
        close = self.end_time
        if close is None and self.orders_by_slot:
            ends = [k.split("-")[-1] for k in self.orders_by_slot if "-" in k]
            close = max(ends) if ends else None
        close = close or "19:00"
        if self.last_order_time is None and len(close) == 5 and close[2] == ":":
            hh, mm = int(close[:2]), int(close[3:])
            total = hh * 60 + mm - 15
            self.last_order_time = f"{total // 60:02d}:{total % 60:02d}"
        return self


class MenuStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str
    duration_sec: float = Field(gt=0, le=500)
    worker: bool
    equipment: Literal["espresso", "steam", "blender"] | None = None


class SelectedMenu(BaseModel):
    model_config = ConfigDict(extra="forbid")
    menu_id: str
    menu_name: str | None = None
    sales_weight: float | None = Field(default=None, ge=0, le=1)
    manufacture_sec: float | None = Field(default=None, gt=0)
    manufacture_stddev_sec: float | None = Field(default=None, ge=0)
    steps: list[MenuStep] | None = None


class CompareRequest(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [
                {
                    "scenario": {"daily_orders": 100, "share_method": "p50"},
                    "execution_mode": "continuous_day",
                    "repetitions": 30,
                    "random_seed": 42,
                    "order_time_sec": 60,
                    "handoff_time_sec": 30,
                    "manufacture_duration_scale": 1.0,
                }
            ]
        },
    )
    session_id: int | None = Field(default=None, gt=0)
    input_version_id: int | None = Field(default=None, gt=0)
    store_id: int | None = Field(default=None, gt=0)
    # Spring이 먼저 만든 결과 번호. 있으면 재생 기록(simulation_trace)을 이 결과에 연결한다.
    result_id: int | None = Field(default=None, gt=0)
    scenario: SimulationScenario = Field(default_factory=SimulationScenario)
    execution_mode: Literal["continuous_day"] = "continuous_day"
    selected_menu_ids: list[str] | None = None
    selected_menus: list[SelectedMenu] | None = None
    menu_weights: dict[str, float] | None = None
    # 가게가 잰 메뉴별 한 잔 제조시간(초, 10~600). 단계 비율은 그대로 두고 늘이거나 줄인다.
    manufacture_sec_by_menu: dict[str, float] | None = None
    equipment_counts: dict[str, int] | None = None
    repetitions: int = Field(default=30, ge=1, le=100)
    random_seed: int = Field(default=42, ge=0, le=2**31 - 1001)
    order_time_sec: float = Field(default=60, ge=1, le=300)
    order_stddev_sec: float = Field(default=15, ge=0, le=300)
    handoff_time_sec: float = Field(default=30, ge=1, le=300)
    handoff_stddev_sec: float = Field(default=10, ge=0, le=300)
    takeout_extra_handoff_sec: float = Field(default=0, ge=0, le=300)
    manufacture_duration_scale: float = Field(default=1, gt=0, le=3)
    manufacture_variability_scale: float = Field(default=1, ge=0, le=3)
    quality_targets: dict[str, float] | None = None
    # 사장님이 고친 구간별 조합 검증용. 네 구간(영업시간 기준) 모두 CURRENT·ALT_A·ALT_C 중 하나.
    slot_choices: dict[str, Literal["CURRENT", "ALT_A", "ALT_C"]] | None = None
    include_events: bool = False
    # Spring(operation)이 보내는 근무표. plans(기존 형식) 또는 choices+staffing_schema_version(직원별 형식).
    # 있으면 그 세 안을 그대로 시뮬레이션한다(staffing_input). 요청 키는 헤더 값을 쓴다.
    plans: list[dict] | None = None
    choices: list[dict] | None = None
    staffing_schema_version: str | None = None
    # Spring은 화면 키(최대 100자) 뒤에 ":simulation"(11자)을 붙여 보낸다.
    request_key: str | None = Field(default=None, max_length=111)


class RosterOwner(BaseModel):
    model_config = ConfigDict(extra="forbid")
    is_working: bool = False
    start_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")
    end_time: str | None = Field(default=None, pattern=r"^\d{2}:\d{2}$")


class RosterRules(BaseModel):
    model_config = ConfigDict(extra="forbid")
    long_shift_hours: float | None = None
    short_shift_hours: float | None = None
    min_staff: int | None = None
    max_staff: int | None = None


class DailyRosterRequest(CompareRequest):
    """하루 근무표 만들기(daily_roster). 손님·메뉴 조건은 compare와 같고, 사람 조건을 더 받는다."""

    owner: RosterOwner = Field(default_factory=RosterOwner)
    hourly_wage_krw: int = Field(gt=0, le=1_000_000)
    is_staff_minor: bool = False
    business_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    roster_rules: RosterRules | None = None


class WeeklyRosterRequest(BaseModel):
    """일주일 근무표(weekly_roster). 요일별 근무조와 직원 명단을 받아 배정한다. 계산이 가벼워 엔진을 다시 돌리지 않는다."""

    model_config = ConfigDict(extra="forbid")
    days: list[dict] = Field(min_length=1, max_length=7)
    workers: list[dict] = Field(min_length=1, max_length=20)
    weekly_mode: Literal["UNDER_15H", "WITH_HOLIDAY_PAY", "COMPARE"] = "COMPARE"
    request_key: str | None = Field(default=None, max_length=111)


class WeekPlanDay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    day: Literal["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
    roster: DailyRosterRequest


class WeekPlanRequest(BaseModel):
    """일주일 근무표 한 번에(week_plan): 요일별 하루 근무표 조건 + 직원 명단."""

    model_config = ConfigDict(extra="forbid")
    days: list[WeekPlanDay] = Field(min_length=1, max_length=7)
    workers: list[dict] = Field(min_length=1, max_length=20)
    weekly_mode: Literal["UNDER_15H", "WITH_HOLIDAY_PAY", "COMPARE"] = "COMPARE"
    request_key: str | None = Field(default=None, max_length=111)


class RosterOptionsRequest(BaseModel):
    """추천 근무표 3안(roster_options): 요일별 하루 근무표 조건 + 직원 명단. 바쁜 시간에만 사람을 더해 비교한다."""

    model_config = ConfigDict(extra="forbid")
    days: list[WeekPlanDay] = Field(min_length=1, max_length=7)
    workers: list[dict] = Field(min_length=1, max_length=20)
    min_gain_sec: float | None = Field(default=None, ge=10, le=300)
    # 주휴 비교(추천안을 긴 근무조로 한 번 더). 빼면 한다. 쉬운 화면은 false.
    compare_holiday_pay: bool | None = None
    # 미리 계산이면 true: 낮은 우선순위로 돌려 진짜 계산에 양보한다(결과는 같다).
    background: bool | None = None
    request_key: str | None = Field(default=None, max_length=111)


class SensitivityRequest(CompareRequest):
    sensitivity_variations: list[list[str | float]] | None = None
