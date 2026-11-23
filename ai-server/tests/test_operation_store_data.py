"""가게 데이터 버전: 영업시간(오픈·마감)과 메뉴별 제조시간.

기본값(07~19시, 제조시간 그대로)이면 결과가 같다는 것은 test_operation_golden이 본다.
"""

import pytest

from app.tools.simulation import day_window
from app.tools.simulation.catalog import config_for
from app.tools.simulation.demand import get_shares, scenario
from app.tools.simulation.simulation_service import compare
from app.tools.simulation.staffing_input import parse as parse_staffing
from app.tools.simulation.trace_log import build_payload
from tests.operation_golden_cases import spring_plans


def _plans(open_time, close_time):
    """Spring OperationInputBuilder와 같은 세 안을 영업시간에 맞춰 늘인다."""
    plans = spring_plans()
    for plan in plans:
        for shift in plan["shifts"]:
            if shift["start_time"] == "07:00":
                shift["start_time"] = open_time
            if shift["end_time"] == "19:00":
                shift["end_time"] = close_time
    return plans


# ---------------------------------------------------------------- 영업시간
def test_day_window_keeps_inner_edges_and_moves_first_and_last_slot():
    day = day_window.make("08:00", "20:00")
    assert day.slots == ("08:00-11:00", "11:00-14:00", "14:00-17:00", "17:00-20:00")
    assert day.length == 12 * 3600 and day.rel("11:00") == 3 * 3600
    assert day_window.make().slots == (
        "07:00-11:00",
        "11:00-14:00",
        "14:00-17:00",
        "17:00-19:00",
    )


@pytest.mark.parametrize(
    "open_time,close_time",
    [("05:30", "19:00"), ("11:00", "19:00"), ("07:15", "19:00"), ("07:00", "17:00"), ("07:00", "21:30")],
)
def test_day_window_rejects_hours_outside_data_or_step(open_time, close_time):
    with pytest.raises(ValueError):
        day_window.make(open_time, close_time)


def test_shares_scale_first_and_last_band_by_hours():
    base = {b["start"]: b for b in get_shares("p50")["time_bands"]}
    longer = {
        b["start"]: b for b in get_shares("p50", day=day_window.make("06:00", "21:00"))["time_bands"]
    }
    # 06~11시 5시간 = 07~11시 4시간의 5/4, 17~21시 4시간 = 17~19시 2시간의 2배. 가운데는 그대로.
    assert longer["06:00"]["adjusted_payment_count"] == pytest.approx(
        base["07:00"]["adjusted_payment_count"] * 5 / 4, abs=1e-2
    )
    assert longer["17:00"]["adjusted_payment_count"] == pytest.approx(
        base["17:00"]["adjusted_payment_count"] * 2, abs=1e-2
    )
    assert longer["11:00"]["adjusted_payment_count"] == base["11:00"]["adjusted_payment_count"]
    assert sum(b["share"] for b in longer.values()) == pytest.approx(1)


def test_scenario_uses_hours_for_slots_and_default_last_order():
    scn = scenario({"daily_orders": 100, "start_time": "08:00", "end_time": "20:00"})
    assert list(scn["orders_by_slot"]) == list(day_window.make("08:00", "20:00").slots)
    assert sum(scn["orders_by_slot"].values()) == 100
    assert scn["last_order_time"] == "19:45" and scn["duration_min"] == 720
    with pytest.raises(ValueError):
        scenario({"daily_orders": 100, "end_time": "20:00", "last_order_time": "20:15"})


def test_engine_plans_follow_hours():
    result = compare(
        {"scenario": {"daily_orders": 80, "start_time": "08:00", "end_time": "20:00"}, "repetitions": 2},
        engine="reference",
    )
    assert result["closing"]["store_open_time"] == "08:00"
    assert result["closing"]["store_close_time"] == "20:00"
    for plan in result["results"]:
        assert [s["slot"] for s in plan["by_slot"]][-1] == "17:00-20:00"
        assert plan["staffing"]["time_slots"][0]["start_time"] == "08:00"
    keys = result["slot_recommendation"]["slot_choice_keys"]
    assert list(keys) == list(day_window.make("08:00", "20:00").slots)


def test_received_plans_use_the_same_hours():
    day = day_window.make("08:00", "20:00")
    with day_window.using(day):
        rosters = parse_staffing({"plans": _plans("08:00", "20:00")}).rosters
        result = compare(
            {
                "scenario": {"daily_orders": 80, "start_time": "08:00", "end_time": "20:00"},
                "repetitions": 2,
                "include_events": True,
            },
            engine="reference",
            plan_rosters=rosters,
        )
    current = next(p for p in result["results"] if p["choice_key"] == "CURRENT")
    assert current["staffing"]["total_staff_hours"] == 24
    payload = build_payload(current, 2, result["scenario"])
    assert payload["time_origin"] == "08:00:00"
    assert payload["observation_window"]["end_seconds"] == 12 * 3600


def test_shorter_day_with_same_orders_is_busier():
    """같은 하루 주문이 더 짧은 영업시간에 몰리면 대기가 늘거나 같다(같은 손님 수, 같은 근무 형태)."""
    def p90(o, c):
        result = compare(
            {"scenario": {"daily_orders": 150, "start_time": o, "end_time": c}, "repetitions": 5},
            engine="reference",
            include_slot_recommendation=False,
        )
        current = next(p for p in result["results"] if p["choice_key"] == "CURRENT")
        return current["metrics"]["p90_post_order_receipt_sec"]["mean"]

    assert p90("10:00", "17:30") >= p90("07:00", "19:00")


def test_router_accepts_store_hours_with_received_plans():
    fastapi = pytest.importorskip("fastapi")
    pytest.importorskip("simpy")
    from fastapi.testclient import TestClient
    from app.core.errors import register_exception_handlers
    from app.tools.simulation.router import router

    app = fastapi.FastAPI()
    register_exception_handlers(app)
    app.include_router(router, prefix="/tools/simulation")
    request = {
        "scenario": {"daily_orders": 40, "start_time": "08:00", "end_time": "20:00"},
        "repetitions": 30,
        "plans": _plans("08:00", "20:00"),
        "manufacture_sec_by_menu": {"iced_americano": 90},
    }
    response = TestClient(app).post(
        "/tools/simulation/compare", json=request, headers={"X-Request-Key": "hours:simulation"}
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["comparison_window"]["start_time"] == "08:00"
    assert data["comparison_window"]["end_time"] == "20:00"
    bad = dict(request, scenario={"daily_orders": 40, "start_time": "11:00"})
    assert (
        TestClient(app)
        .post("/tools/simulation/compare", json=bad, headers={"X-Request-Key": "bad:simulation"})
        .status_code
        == 400
    )


# ---------------------------------------------------------------- 메뉴별 제조시간
def test_manufacture_time_scales_steps_and_keeps_shape():
    base = next(m for m in config_for({})["menus"] if m["menu_id"] == "iced_cafe_latte")
    conf = config_for({"manufacture_sec_by_menu": {"iced_cafe_latte": base["manufacture_sec"] * 2}})
    menu = next(m for m in conf["menus"] if m["menu_id"] == "iced_cafe_latte")
    assert menu["manufacture_sec"] == pytest.approx(base["manufacture_sec"] * 2)
    assert [s["worker"] for s in menu["steps"]] == [s["worker"] for s in base["steps"]]
    assert [s["equipment"] for s in menu["steps"]] == [s["equipment"] for s in base["steps"]]
    for new, old in zip(menu["steps"], base["steps"]):
        assert new["duration_sec"] == pytest.approx(old["duration_sec"] * 2)
    other = next(m for m in conf["menus"] if m["menu_id"] == "iced_americano")
    assert other == next(m for m in config_for({})["menus"] if m["menu_id"] == "iced_americano")


@pytest.mark.parametrize("times", [{"latte": 60}, {"iced_americano": 5}, {"iced_americano": 900}, []])
def test_manufacture_time_rejects_unknown_menu_or_range(times):
    with pytest.raises(ValueError):
        config_for({"manufacture_sec_by_menu": times})


def test_slower_drinks_make_waits_longer():
    def p90(times):
        body = {"scenario": {"daily_orders": 120}, "repetitions": 5}
        if times:
            body["manufacture_sec_by_menu"] = times
        result = compare(body, engine="reference", include_slot_recommendation=False)
        return next(p for p in result["results"] if p["choice_key"] == "CURRENT")["metrics"][
            "p90_post_order_receipt_sec"
        ]["mean"]

    assert p90({"iced_americano": 150}) > p90(None)


# ---------------------------------------------------------------- 대화 입력과 가게 데이터
def test_chat_reads_store_hours_and_cups_from_the_form():
    from app.agent import operation_fields as f

    values = {
        "is_owner_working": True,
        "hourly_wage_krw": 10320,
        "open_time": "08:00",
        "close_time": "20:00",
        "menu_cups": {"iced_americano": 70, "iced_cafe_latte": 30},
    }
    assert f.is_complete(values) and f.next_missing(values) is None
    summary = f.summary({f.DRAFT_KEY: values})
    assert summary["daily_orders"] == 100 and summary["last_order_time"] == "19:45(기본)"
    assert "08:00~20:00" in summary["fixed"] and "store_data" in summary
    assert f.check({**values, "last_order_time": "19:30"}, "last_order_time") is None
    assert "19:30~20:00" in f.check({**values, "last_order_time": "19:00"}, "last_order_time")
    # 잔 수 합계와 같은 하루 주문은 그대로, 다른 값은 폼에서 고치라고 안내한다.
    assert f.check({**values, "daily_orders": 100}, "daily_orders") is None
    assert "가게 데이터" in f.check({**values, "daily_orders": 150}, "daily_orders")


def test_chat_defaults_are_unchanged_without_store_data():
    from app.agent import operation_fields as f

    values = {"daily_orders": 100, "is_owner_working": True, "hourly_wage_krw": 10320}
    summary = f.summary({f.DRAFT_KEY: values})
    assert summary["last_order_time"] == "18:45(기본)" and "store_data" not in summary
    assert "18:30~19:00" in f.check({**values, "last_order_time": "18:00"}, "last_order_time")



# ---------------------------------------------------------------- 가게 시간대(1시간 단위)·바쁜 시간
HOURLY = {f"{h:02d}:00-{h + 1:02d}:00": n for h, n in zip(range(8, 20), [12, 15, 10, 8, 20, 18, 9, 6, 5, 6, 4, 3])}


def test_store_slots_set_hours_edges_and_peak():
    day = day_window.from_scenario({"orders_by_slot": HOURLY, "peak_start_time": "12:00", "peak_end_time": "14:00"})
    assert day.is_store and (day.open, day.close) == ("08:00", "20:00")
    assert len(day.slots) == 12 and day.peak == ("12:00", "14:00")
    # 상권 네 칸 이름이면 지금 버전 하루다.
    assert not day_window.from_scenario({"orders_by_slot": dict.fromkeys(day_window.DEFAULT.slots, 1)}).is_store


@pytest.mark.parametrize(
    "spec",
    [
        {"orders_by_slot": {"08:00-09:00": 1, "10:00-11:00": 1, "11:00-12:00": 1, "12:00-13:00": 1}},
        {"orders_by_slot": {"08:00-10:00": 1, "10:00-11:00": 1}},
        {"orders_by_slot": {"04:00-08:00": 1, "08:00-12:00": 1}},
        {"orders_by_slot": HOURLY, "peak_start_time": "12:30", "peak_end_time": "14:00"},
        {"orders_by_slot": HOURLY, "end_time": "21:00"},
    ],
)
def test_store_slots_reject_gaps_short_days_and_off_edge_peak(spec):
    with pytest.raises(ValueError):
        day_window.from_scenario(spec)


def test_store_slots_keep_counts_and_skip_district_shares():
    scn = scenario({"orders_by_slot": HOURLY})
    assert scn["orders_by_slot"] == HOURLY and scn["last_order_time"] == "19:45"
    assert scn["source"]["basis"] == "STORE_ENTERED_SLOT_ORDER_COUNTS"
    with pytest.raises(ValueError):
        # 가게 시간대에서 하루 주문만 주면 나눌 근거가 없다(이 경우는 하루를 만들 수 없다).
        scenario({"daily_orders": 100, "orders_by_slot": HOURLY})


def test_engine_plans_change_only_in_the_given_peak():
    result = compare(
        {"scenario": {"orders_by_slot": HOURLY, "peak_start_time": "12:00", "peak_end_time": "14:00"}, "repetitions": 2},
        engine="reference",
        include_slot_recommendation=False,
    )
    extra = next(p for p in result["results"] if p["choice_key"] == "ALT_C")
    counts = {s["start_time"]: s["staff_count"] for s in extra["staffing"]["time_slots"]}
    assert counts["12:00"] == counts["13:00"] == 3 and counts["11:00"] == counts["14:00"] == 2
    assert extra["staffing"]["total_staff_hours"] == 26


def test_received_plans_on_store_slots():
    plans = _plans("08:00", "20:00")
    for plan in plans:
        for shift in plan["shifts"]:
            shift["start_time"] = {"11:00": "12:00", "14:00": "14:00"}.get(shift["start_time"], shift["start_time"])
            shift["end_time"] = {"11:00": "12:00"}.get(shift["end_time"], shift["end_time"])
    spec = {"orders_by_slot": HOURLY, "peak_start_time": "12:00", "peak_end_time": "14:00"}
    with day_window.using(day_window.from_scenario(spec)):
        rosters = parse_staffing({"plans": plans}).rosters
        result = compare({"scenario": spec, "repetitions": 2}, engine="reference", plan_rosters=rosters)
    assert [s["slot"] for s in result["results"][0]["by_slot"]] == list(HOURLY)
    assert result["closing"]["store_close_time"] == "20:00"


def test_chat_reads_store_slots_and_peak():
    from app.agent import operation_fields as f

    values = {
        "is_owner_working": True,
        "hourly_wage_krw": 10320,
        "orders_by_slot": HOURLY,
        "peak_start_time": "12:00",
        "peak_end_time": "14:00",
    }
    assert f.is_complete(values)
    summary = f.summary({f.DRAFT_KEY: values})
    assert summary["daily_orders"] == sum(HOURLY.values()) and summary["last_order_time"] == "19:45(기본)"
    assert "08:00~20:00" in summary["fixed"] and "12:00~14:00(가게 데이터)" in summary["fixed"]
