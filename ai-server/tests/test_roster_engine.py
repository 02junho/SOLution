"""근무표 계산 엔진 동일성: 가벼운 스케줄러(reference)와 SimPy가 같은 결과를 내야 근무표 계산에 reference를 쓸 수 있다.

두 엔진 모두 "가장 이른 시각부터, 같은 시각이면 예약한 순서대로" 이벤트를 처리한다. 결과(필요 인원·근무조·대기 숫자)가
하나라도 달라지면 이 테스트가 실패하고, 그때는 router.ROSTER_ENGINE을 "simpy"로 돌리면 된다.
"""

import json

import pytest

from app.tools.simulation import router
from app.tools.simulation.roster_options import day_options

HOURS = {
    "아침·점심 붐빔": [10, 34, 38, 30, 22, 36, 30, 12, 11, 10, 8, 6, 4],
    "점심만 붐빔": [6, 8, 10, 12, 24, 26, 22, 9, 8, 7, 4, 3, 2],
}


@pytest.mark.parametrize("name", list(HOURS))
@pytest.mark.parametrize("owner", [True, False])
def test_reference와_simpy가_숫자_하나까지_같다(name, owner):
    body = {
        "scenario": {
            "orders_by_slot": {f"{h:02d}:00-{h + 1:02d}:00": n for h, n in zip(range(7, 20), HOURS[name])},
            "peak_start_time": "11:00",
            "peak_end_time": "14:00",
        },
        "repetitions": 10,
        "hourly_wage_krw": 10320,
        "business_date": "2026-11-20",
        "owner": {"is_working": owner, **({"start_time": "07:00", "end_time": "15:00"} if owner else {})},
    }
    fast = day_options(body, engine="reference")
    real = day_options(body, engine="simpy")
    assert json.dumps(fast, sort_keys=True, default=str) == json.dumps(real, sort_keys=True, default=str)


def test_근무표_계산은_reference_엔진을_쓴다():
    assert router.ROSTER_ENGINE == "reference"
