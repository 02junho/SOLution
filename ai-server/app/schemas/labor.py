"""인건비·계획 배치표 계약. JSON 이름은 공유 API 명세 그대로 유지한다."""

from datetime import date
from decimal import Decimal
import re
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictBool, field_validator, model_validator

Identifier = Annotated[int, Field(strict=True, gt=0)]
ChoiceKey = Literal["CURRENT", "ALT_A", "ALT_C"]
CHOICES = ("CURRENT", "ALT_A", "ALT_C")


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class TimeWindow(Contract):
    start_time: str
    end_time: str

    @field_validator("start_time", "end_time")
    @classmethod
    def valid_time(cls, value: str) -> str:
        if not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", value):
            raise ValueError("시각은 HH:mm 형식이어야 합니다.")
        return value

    @model_validator(mode="after")
    def positive_interval(self):
        if self.start_time >= self.end_time:
            raise ValueError("같은 날의 시작 시각이 종료 시각보다 빨라야 합니다.")
        return self


class Break(TimeWindow):
    is_paid: StrictBool = False


class Shift(TimeWindow):
    worker_key: str = Field(min_length=1, max_length=50)
    task_code: Literal[
        "ALL_TASKS", "ORDER_HANDOFF", "PREPARATION",
        "ORDER_HANDOFF_HELP_PREPARATION", "PREPARATION_HELP_ORDER_HANDOFF",
        "ORDER", "MAKE", "FLEX",
    ]
    breaks: list[Break] = Field(default_factory=list)
    primary_role: Literal["ORDER", "MAKE", "FLEX"] | None = None
    can_support: list[Literal["ORDER", "MAKE"]] = Field(default_factory=list)

    @model_validator(mode="after")
    def explicit_roles(self):
        if self.task_code in ("ORDER", "MAKE", "FLEX"):
            if self.primary_role != self.task_code or "can_support" not in self.model_fields_set:
                raise ValueError("새 배치 계약은 task_code와 primary_role을 명시해 일치시켜야 합니다.")
        elif self.primary_role is not None or self.can_support:
            raise ValueError("기존 업무 코드와 새 역할 계약을 혼합할 수 없습니다.")
        if len(set(self.can_support)) != len(self.can_support) or self.primary_role in self.can_support:
            raise ValueError("지원 업무가 중복되거나 기본 업무와 같습니다.")
        return self


class Worker(Contract):
    worker_key: str = Field(min_length=1, max_length=50)
    is_owner: StrictBool
    is_minor: StrictBool | None = None
    employment_type: Literal["hourly", "salaried"] = "hourly"
    hourly_wage_krw: Decimal | None = Field(default=None, ge=0)

    @field_validator("hourly_wage_krw", mode="before", json_schema_input_type=int | float | None)
    @classmethod
    def numeric_wage(cls, value):
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float, Decimal))):
            raise ValueError("시급은 숫자 또는 null이어야 합니다.")
        return value


class Plan(Contract):
    choice_key: ChoiceKey
    shifts: list[Shift] = Field(min_length=1, max_length=100)


class LaborInput(Contract):
    session_id: Identifier
    input_version_id: Identifier
    business_date: date
    workers: list[Worker] = Field(min_length=1, max_length=20)
    plans: list[Plan] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def unique_keys(self):
        keys = [w.worker_key for w in self.workers]
        if len(set(keys)) != len(keys):
            raise ValueError("worker_key가 중복되었습니다.")
        if {p.choice_key for p in self.plans} != set(CHOICES):
            raise ValueError("CURRENT·ALT_A·ALT_C를 각각 하나씩 보내 주세요.")
        for plan in self.plans:
            if any(s.worker_key not in keys for s in plan.shifts):
                raise ValueError("등록되지 않은 직원의 근무가 있습니다.")
        return self


class ScheduleRequest(LaborInput):
    timezone: Literal["Asia/Seoul"] = "Asia/Seoul"
    rule_policy_version: str = "labor.kr.2026.v1"
    auto_break: StrictBool = True
    avoid_break_windows: list[TimeWindow] = Field(default_factory=list)


class CostOptions(Contract):
    include_weekly_holiday: StrictBool = False
    include_employer_insurance: StrictBool = False


class WeeklyWorkerContext(Contract):
    # 소정근로시간과 개근은 실제 하루 체류시간으로 추측하지 않는다.
    scheduled_weekly_seconds: Annotated[int, Field(strict=True, ge=0, le=144000)]
    scheduled_days_per_week: Annotated[int, Field(strict=True, ge=1, le=7)]
    average_weekly_scheduled_seconds: Annotated[int | None, Field(strict=True, ge=0, le=144000)] = None
    attended_all_scheduled_days: StrictBool | None = None
    employment_continues_through_holiday: StrictBool | None = None


class WeeklyContext(Contract):
    # 이 계산의 비교대상 통상근로자 패턴은 주 40시간·5일이다.
    comparable_full_time_days_per_week: Literal[5] = 5
    workers: dict[str, WeeklyWorkerContext]


class InsuranceWorkerContext(Contract):
    applies: dict[str, StrictBool | None]


class InsuranceContext(Contract):
    policy_version: str
    workers: dict[str, InsuranceWorkerContext]


class MonthlyProjection(Contract):
    weeks_per_month: Decimal = Field(gt=0, le=6)
    worker_days_per_week: dict[str, Annotated[int, Field(strict=True, ge=1, le=7)]]


class CostRequest(LaborInput):
    wage_year: Annotated[int, Field(strict=True)] = 2026
    assumptions_version: str = Field(min_length=1, max_length=100)
    cost_options: CostOptions = Field(default_factory=CostOptions)
    weekly_context: WeeklyContext | None = None
    insurance_context: InsuranceContext | None = None
    monthly_projection: MonthlyProjection | None = None
