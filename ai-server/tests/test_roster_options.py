"""추천 근무표 3안: 바쁜 시간 2구간, 바쁜 시간에만 더하기, 추천 고르기, 주 15시간 미만 배정."""


import pytest

from app.tools.simulation import roster_options as ro
from app.tools.simulation.day_window import from_scenario, using
from app.tools.simulation.simulation_common import _scenario


def _slots(values, start=7):
    return {f"{h:02d}:00-{h + 1:02d}:00": n for h, n in zip(range(start, start + len(values)), values)}


def _windows(values, peak=("11:00", "14:00")):
    spec = {"orders_by_slot": _slots(values), "peak_start_time": peak[0], "peak_end_time": peak[1]}
    with using(from_scenario(spec)):
        return [(w["start_time"], w["end_time"]) for w in ro.busy_windows(_scenario(spec))]


def test_바쁜_시간은_최대_2구간_떨어져_있고_충분히_붐빌_때만():
    # 아침 7~10시도 붐빈다 → 둘째 구간
    assert _windows([18, 22, 20, 10, 24, 26, 22, 7, 6, 7, 2, 1, 2]) == [("07:00", "10:00"), ("11:00", "14:00")]
    # 아침이 하루 평균 정도면 한 구간만
    assert _windows([12, 12, 12, 12, 23, 24, 22, 7, 6, 7, 2, 1, 2]) == [("11:00", "14:00")]
    # 첫 구간 바로 옆만 잠깐 붐비면(앞뒤가 한가하면) 둘째 구간이 아니다
    assert _windows([2, 2, 2, 30, 24, 26, 22, 2, 2, 2, 2, 2, 2]) == [("11:00", "14:00")]
    # 아침부터 점심까지 길게 바쁘면 붙은 두 구간
    assert _windows([10, 34, 38, 30, 22, 36, 30, 12, 11, 10, 8, 6, 4], peak=("08:00", "11:00")) == [
        ("08:00", "11:00"),
        ("11:00", "14:00"),
    ]


def test_상권_비중_4구간일_때는_한_구간만():
    with using(from_scenario({"daily_orders": 150})):
        assert [(w["start_time"], w["end_time"]) for w in ro.busy_windows(_scenario({"daily_orders": 150}))] == [
            ("11:00", "14:00")
        ]


def test_추천은_한_명_더할_때_대기가_충분히_줄어드는_데까지():
    ladder = [{"extra": k, "peak_wait_sec": w} for k, w in enumerate([300, 200, 185, 184])]
    assert ro._pick(ladder, 30) == {"SAVE": 0, "RECOMMENDED": 1, "ROOMY": 2}
    assert ro._pick(ladder, 10) == {"SAVE": 0, "RECOMMENDED": 2, "ROOMY": 3}
    # 더해도 거의 안 줄면 아끼는 안이 곧 추천, 여유 안은 +1
    flat = [{"extra": k, "peak_wait_sec": w} for k, w in enumerate([150, 140, 139])]
    assert ro._pick(flat, 30) == {"SAVE": 0, "RECOMMENDED": 0, "ROOMY": 1}
    # 최대 인원에 닿아 더 못 더하면 여유 안도 그 자리
    top = [{"extra": 0, "peak_wait_sec": 400}, {"extra": 1, "peak_wait_sec": 200}]
    assert ro._pick(top, 30) == {"SAVE": 0, "RECOMMENDED": 1, "ROOMY": 1}


def _day(name, values, owner=True):
    return {
        "day": name,
        "roster": {
            "scenario": {"orders_by_slot": _slots(values), "peak_start_time": "11:00", "peak_end_time": "14:00"},
            "repetitions": 8,
            "hourly_wage_krw": 10320,
            "business_date": "2026-11-20",
            "owner": {"is_working": owner, **({"start_time": "07:00", "end_time": "15:00"} if owner else {})},
        },
    }


WORKERS = [
    {"worker_key": f"w{i}", "name": f"직원 {i}", "hourly_wage_krw": 10320, "max_weekly_hours": 14,
     "available": {d: ["07:00", "20:00"] for d in ("MON", "TUE")}}
    for i in range(8)
]


def test_세_안과_주휴_비교를_한_번에_만든다():
    out = ro.plan(
        {"days": [_day("MON", [18, 22, 20, 10, 24, 26, 22, 7, 6, 7, 2, 1, 2]), _day("TUE", [6, 6, 6, 6, 12, 12, 10, 4, 4, 4, 2, 1, 1])],
         "workers": WORKERS}
    )
    assert out["model_version"] == "operation.roster_options.v1"
    keys = [o["key"] for o in out["options"]]
    assert keys == ["SAVE", "RECOMMENDED", "ROOMY"]
    save, rec, roomy = out["options"]
    for day_name in ("MON", "TUE"):
        assert save["extra_by_day"][day_name] == 0
        assert save["extra_by_day"][day_name] <= rec["extra_by_day"][day_name] <= roomy["extra_by_day"][day_name]
        # 더 쓰는 안일수록 인건비가 같거나 크다
        assert save["daily_cost_krw"][day_name] <= roomy["daily_cost_krw"][day_name]
    # 15시간 미만: 배정된 사람은 모두 주 15시간 미만, 주휴 0원
    for o in out["options"]:
        assert all(w["weekly_work_hours"] < 15 for w in o["weekly"]["workers"])
        assert o["weekly"]["holiday_pay_krw"] == 0
        hours = sum(u["work_hours"] for u in o["weekly"]["unfilled"])
        assert o["shortfall"] == {"unfilled_hours": hours, "more_people_under_15h": len(o["new_hires"])}
        # 새 알바: 못 채운 자리를 빠짐없이, 하루 한 근무, 주 14.5시간 이하
        placed = [a["slot_id"] for h in o["new_hires"] for a in h["assignments"]]
        assert sorted(placed) == sorted(u["slot_id"] for u in o["weekly"]["unfilled"])
        # 못 채운 자리도 휴게를 실어 보낸다(화면이 근무조 순서로 다시 찾지 않게)
        assert all("breaks" in u for u in o["weekly"]["unfilled"])
        for h in o["new_hires"]:
            days = [a["day"] for a in h["assignments"]]
            assert len(days) == len(set(days)) and h["weekly_work_hours"] <= 14.5
            # 주 예상 급여 = 주 근무시간 × 요일 조건의 시급(배정한 직원과 같은 식)
            assert h["base_wage_krw"] == round(h["weekly_work_hours"] * 10320)
    assert out["holiday_compare"]["key"] == "RECOMMENDED"
    assert out["days"]["MON"]["windows"][0]["start_time"] == "07:00"  # 아침 구간도 잡음
    assert len(out["days"]["MON"]["ladder"]) >= 2


def test_입력_검사():
    with pytest.raises(ValueError):
        ro.plan({"days": [], "workers": WORKERS})
    with pytest.raises(ValueError):
        ro.plan({"days": [_day("MON", [5] * 13)], "workers": WORKERS, "min_gain_sec": 5})


def test_더하기_비교는_여유_안_다음에서_멈춘다():
    out = ro.plan({"days": [_day("MON", [18, 22, 20, 10, 24, 26, 22, 7, 6, 7, 2, 1, 2])], "workers": WORKERS})
    day = out["days"]["MON"]
    # 마지막으로 돌린 단계가 여유 안이거나, 최대(+3)까지 간 경우다.
    assert len(day["ladder"]) - 1 in (day["picks"]["ROOMY"], ro.MAX_EXTRA)


def test_새_알바는_하루_한_근무_주_한도_안에서_긴_자리부터():
    from app.tools.simulation.weekly_roster import new_hires

    u = lambda sid, day, start, end, h: {"slot_id": sid, "day": day, "start_time": start, "end_time": end, "work_hours": h}  # noqa: E731
    hires = new_hires([u("MON-1", "MON", "07:00", "12:00", 4.5), u("MON-2", "MON", "12:00", "15:30", 3.5),
                       u("TUE-1", "TUE", "07:00", "12:00", 4.5), u("WED-1", "WED", "07:00", "12:00", 4.5),
                       u("THU-1", "THU", "07:00", "12:00", 4.5)], 14.5)
    assert [h["name"] for h in hires] == ["새 직원 1", "새 직원 2"]
    # 1번: 월·화·수 4.5시간씩 13.5시간(목요일을 더하면 18시간이라 2번에게)
    assert [a["slot_id"] for a in hires[0]["assignments"]] == ["MON-1", "TUE-1", "WED-1"]
    assert [a["slot_id"] for a in hires[1]["assignments"]] == ["MON-2", "THU-1"]
    assert new_hires([], 14.5) == []
    with pytest.raises(ValueError):
        new_hires([u("MON-1", "MON", "07:00", "23:00", 15.5)], 14.5)
