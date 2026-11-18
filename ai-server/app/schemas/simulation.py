"""Public API input models for Swagger and team snake_case conventions."""

from __future__ import annotations
from typing import Literal
from pydantic import BaseModel, Field, ConfigDict


class SimulationScenario(BaseModel):
    model_config = ConfigDict(extra="forbid")
    area: Literal["을지로입구역"] = "을지로입구역"
    share_method: Literal["p50", "latest", "quarter"] = "p50"
    quarter: str | None = None
    start_time: Literal["07:00"] = "07:00"
    end_time: Literal["19:00"] = "19:00"
    last_order_time: str = "18:45"
    daily_orders: int | None = Field(default=None, ge=0, le=5000)
    orders_by_slot: dict[str, int] | None = None
    demand_level: Literal["low", "medium", "high"] | None = None
    takeout_ratio: float = Field(default=0.4, ge=0, le=1)


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
    # 사장님이 고친 구간별 조합 검증용. 네 구간 모두 CURRENT·ALT_A·ALT_C 중 하나.
    slot_choices: (
        dict[
            Literal["07:00-11:00", "11:00-14:00", "14:00-17:00", "17:00-19:00"],
            Literal["CURRENT", "ALT_A", "ALT_C"],
        ]
        | None
    ) = None
    include_events: bool = False
    # Spring(operation)이 보내는 근무표. plans(기존 형식) 또는 choices+staffing_schema_version(직원별 형식).
    # 있으면 그 세 안을 그대로 시뮬레이션한다(staffing_input). 요청 키는 헤더 값을 쓴다.
    plans: list[dict] | None = None
    choices: list[dict] | None = None
    staffing_schema_version: str | None = None
    request_key: str | None = Field(default=None, max_length=100)


class SensitivityRequest(CompareRequest):
    sensitivity_variations: list[list[str | float]] | None = None
