"""Labor 공개 서비스 진입점. 계산을 cost/schedule로 나누어도 도구 종류는 labor 하나다."""

from app.tools.labor import cost, schedule
from app.schemas.labor import CostRequest, ScheduleRequest


def calculate_cost(body: CostRequest):
    return cost.run(body)


def create_schedule(body: ScheduleRequest):
    return schedule.run(body)
