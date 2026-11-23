"""추천 근무표 줄 서는 모습: 같은 첫 반복을 다시 돌려 재생 기록을 만든다(저장 없음)."""

import pytest

from app.tools.simulation.daily_roster import plan as daily
from app.tools.simulation.roster_replay import replay
from tests.test_operation_store_data import HOURLY

pytest.importorskip("simpy")

BODY = {
    "scenario": {"orders_by_slot": HOURLY},
    "repetitions": 5,
    "owner": {"is_working": True, "start_time": "08:00", "end_time": "16:00"},
    "hourly_wage_krw": 10320,
    "business_date": "2026-11-20",
}


@pytest.fixture(scope="module")
def shifts():
    return daily(BODY, engine="reference")["shifts"]


def test_재생_기록_모양(shifts):
    out = replay({"roster": BODY, "shifts": shifts, "choice_key": "RECOMMENDED"}, engine="reference")
    assert out["trace_schema_version"] == "operation.trace.v2"
    assert out["choice_key"] == "RECOMMENDED"
    assert out["time_origin"] == "08:00:00"
    assert out["event_count"] == len(out["events"]) > 0
    kinds = {e["event_type"] for e in out["events"]}
    assert {"ARRIVED", "ORDER_STARTED", "HANDED_OVER"} <= kinds
    # 손님은 모두 받아 간다(마감 전 주문은 끝까지 만든다)
    arrived = {e["customer_key"] for e in out["events"] if e["event_type"] == "ARRIVED"}
    handed = {e["customer_key"] for e in out["events"] if e["event_type"] == "HANDED_OVER"}
    assert arrived == handed


def test_직원은_근무조_이름만(shifts):
    out = replay({"roster": BODY, "shifts": shifts}, engine="reference")
    keys = set(out["initial_state"]["active_staff_keys"]) | {e["worker_key"] for e in out["events"] if e["worker_key"]}
    assert keys <= {s["worker_key"] for s in shifts}
    assert all(k == "OWNER" or k.startswith("STAFF_") for k in keys)


def test_엔진이_달라도_같은_기록(shifts):
    a = replay({"roster": BODY, "shifts": shifts}, engine="reference")
    b = replay({"roster": BODY, "shifts": shifts}, engine="simpy")
    assert a["events"] == b["events"]


def test_휴게_중에는_빠진다(shifts):
    rested = [s for s in shifts if s["breaks"]]
    if not rested:
        pytest.skip("이 조건에는 휴게가 없어요")
    out = replay({"roster": BODY, "shifts": shifts}, engine="reference")
    key = rested[0]["worker_key"]
    offs = [e for e in out["events"] if e["event_type"] == "STAFF_OFF" and e["worker_key"] == key]
    assert offs, "휴게 시작에 STAFF_OFF가 있어야 해요"


def test_잘못된_근무조():
    with pytest.raises(ValueError):
        replay({"roster": BODY, "shifts": []})
    with pytest.raises(ValueError):
        replay({"roster": BODY, "shifts": [{"worker_key": "X"}]})
    with pytest.raises(ValueError):
        replay({"shifts": [{"worker_key": "X", "start_time": "08:00", "end_time": "12:00"}]})


def test_라우터(shifts):
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = fastapi.FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    client = TestClient(app)
    ok = client.post("/tools/simulation/roster-replay", json={"roster": BODY, "shifts": shifts}, headers={"X-Request-Key": "r:replay"})
    assert ok.status_code == 200, ok.text
    assert ok.json()["data"]["model_version"] == "operation.roster_replay.v1"
    bad = client.post("/tools/simulation/roster-replay", json={"roster": BODY, "shifts": []}, headers={"X-Request-Key": "r:replay2"})
    assert bad.status_code == 400
