"""인건비 경계·휴게·공통 응답 계약. 실제 급여 정산 검증이나 SimPy 검증을 대신하지 않는다."""

from copy import deepcopy
from decimal import Decimal
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app.main import app
from app.tools.labor import cost, policies, schedule
from app.tools.labor.schemas import CostRequest, ScheduleRequest
import app.tools.labor.router as labor_router

ROOT = Path(__file__).resolve().parents[2]
BASE = json.loads((ROOT / "data/demo/operation/schedule_request.json").read_text())


@pytest.fixture
def logs(monkeypatch):
    rows = []
    monkeypatch.setattr(labor_router, "write_tool_log", lambda **kwargs: rows.append(kwargs))
    return rows


def schedule_body():
    return deepcopy(BASE)


def cost_body():
    body = schedule_body()
    generated = schedule.run(ScheduleRequest.model_validate(body)).data
    return {"session_id": body["session_id"], "input_version_id": body["input_version_id"],
            "business_date": body["business_date"], "wage_year": 2026, "assumptions_version": "test.v1",
            "workers": body["workers"],
            "plans": [{"choice_key": p["choice_key"], "shifts": p["schedule"]} for p in generated["plans"]],
            "cost_options": {"include_weekly_holiday": False, "include_employer_insurance": False},
            "monthly_projection": {"weeks_per_month": 4.345, "worker_days_per_week": {"STAFF_1": 5, "STAFF_2": 5}}}


def costs(body):
    return cost.run(CostRequest.model_validate(body))


def test_base_wage_owner_and_monthly_projection():
    result = costs(cost_body())
    rows = {p["choice_key"]: p for p in result.data["plans"]}
    assert result.status == "ok"
    assert rows["CURRENT"]["employee_paid_seconds"] == 28800
    assert rows["CURRENT"]["owner_work_seconds"] == 43200
    assert rows["CURRENT"]["cash_cost_krw"] == 82560
    assert rows["ALT_A"]["additional_cash_cost_krw"] == 0
    assert rows["ALT_C"]["cash_cost_krw"] == 103200
    assert rows["ALT_C"]["additional_cash_cost_krw"] == 20640
    assert rows["ALT_C"]["additional_monthly_cash_cost_estimate_krw"] == 448404
    assert rows["CURRENT"]["weekly_holiday_cost_krw"] is None
    assert rows["CURRENT"]["employer_insurance_cost_krw"] is None


@pytest.mark.parametrize("wage", [None, 0, 10000, 10319.99])
def test_unknown_or_below_minimum_is_not_silently_replaced(wage):
    body = cost_body(); body["workers"][1]["hourly_wage_krw"] = wage
    result = costs(body)
    assert result.status == "needs_input"
    assert result.data["missing_fields"][0] == {"path": "workers[1].hourly_wage_krw", "label": "STAFF_1 실제 시급", "unit": "원"}


def test_actual_wage_and_2027_policy():
    body = cost_body(); body["wage_year"] = 2027
    body["business_date"] = "2027-01-04"
    body["workers"][1]["hourly_wage_krw"] = 12000
    body["workers"][2]["hourly_wage_krw"] = 10700
    result = costs(body)
    assert result.data["minimum_hourly_wage_krw"] == 10700
    assert result.data["plans"][0]["cash_cost_krw"] == 96000
    assert result.data["plans"][2]["additional_cash_cost_krw"] == 21400


def test_unknown_wage_year_needs_policy():
    body = cost_body(); body["wage_year"] = 2030
    body["business_date"] = "2030-01-04"
    assert costs(body).status == "needs_input"


def test_paid_break_keeps_employee_pay_but_owner_time_excludes_rest():
    body = cost_body()
    for plan in body["plans"]:
        for shift in plan["shifts"]:
            for rest in shift["breaks"]: rest["is_paid"] = True
        plan["shifts"][1]["breaks"] = [{"start_time": "12:00", "end_time": "12:30", "is_paid": True}]
    row = costs(body).data["plans"][0]
    assert row["cash_cost_krw"] == 92880
    assert row["owner_work_seconds"] == 41400


def test_missing_monthly_pattern_is_null_for_affected_plan():
    body = cost_body(); body["monthly_projection"]["worker_days_per_week"].pop("STAFF_2")
    result = costs(body).data
    assert result["plans"][0]["monthly_cash_cost_estimate_krw"] == 1793616
    assert result["plans"][2]["monthly_cash_cost_estimate_krw"] is None
    assert result["plans"][2]["additional_monthly_cash_cost_estimate_krw"] is None


def test_weekly_holiday_requires_context():
    body = cost_body(); body["cost_options"]["include_weekly_holiday"] = True
    result = costs(body)
    assert result.status == "needs_input"
    assert result.data["missing_fields"] == [{"path": "weekly_context", "label": "주간 근무 조건", "unit": None}]


@pytest.mark.parametrize("weekly_seconds,attendance,expected", [(14*3600+1800, None, 0), (15*3600, True, 6192), (40*3600, True, 16512), (40*3600, False, 0)])
def test_weekly_holiday_threshold_and_attendance(weekly_seconds, attendance, expected):
    body = cost_body(); body["cost_options"]["include_weekly_holiday"] = True
    body["weekly_context"] = {"workers": {key: {"scheduled_weekly_seconds": weekly_seconds, "average_weekly_scheduled_seconds": weekly_seconds, "scheduled_days_per_week": 5,
                                               "attended_all_scheduled_days": attendance, "employment_continues_through_holiday": True}
                                            for key in ("STAFF_1", "STAFF_2")}}
    result = costs(body)
    assert result.status == "ok"
    assert result.data["plans"][0]["weekly_holiday_cost_krw"] == expected
    if not attendance:
        assert not any("개근 가정" in note for note in result.data["assumptions"])


def test_insurance_has_no_unverified_default_rate():
    body = cost_body(); body["cost_options"]["include_employer_insurance"] = True
    assert costs(body).status == "needs_input"


def test_approved_insurance_components_and_rounding(monkeypatch):
    # 1%는 알고리즘 검증용 합성 정책이며 실제 법정 요율이 아니다.
    rates = {k: 0 for k in policies.INSURANCE_COMPONENTS}; rates["pension"] = Decimal("0.01")
    monkeypatch.setitem(policies.APPROVED_INSURANCE_POLICIES, "test-only", {"year": 2026, "source_ref": "unit-test-only", "rates": rates})
    body = cost_body(); body["cost_options"]["include_employer_insurance"] = True
    body["insurance_context"] = {"policy_version": "test-only", "workers": {
        key: {"applies": {k: k == "pension" for k in policies.INSURANCE_COMPONENTS}} for key in ("STAFF_1", "STAFF_2")}}
    assert costs(body).data["plans"][0]["employer_insurance_cost_krw"] == 826


def test_auto_break_avoids_peak_and_preserves_shifts():
    before = schedule_body()
    result = schedule.run(ScheduleRequest.model_validate(before))
    assert result.status == "ok"
    for plan in result.data["plans"]:
        rests = [b for row in plan["schedule"] if row["worker_key"] == "STAFF_1" for b in row["breaks"]]
        assert rests == [{"start_time": "14:00", "end_time": "15:00", "is_paid": False}]
    assert all(not s["breaks"] for p in before["plans"] for s in p["shifts"])


@pytest.mark.parametrize("span,expected_rest", [(3, 0), (4, 1800), (8, 1800), (9, 3600)])
def test_actual_work_vs_presence_break_boundary(span, expected_rest):
    body = schedule_body()
    for plan in body["plans"]:
        plan["shifts"] = [{"worker_key": "STAFF_1", "start_time": "07:00", "end_time": f"{7+span:02d}:00", "task_code": "ALL_TASKS", "breaks": []}]
    result = schedule.run(ScheduleRequest.model_validate(body))
    assert result.status == "ok"
    rest = result.data["plans"][0]["schedule"][0]["breaks"]
    assert sum(schedule.seconds(x["end_time"])-schedule.seconds(x["start_time"]) for x in rest) == expected_rest


def test_auto_break_disabled_is_infeasible():
    body = schedule_body(); body["auto_break"] = False
    assert schedule.run(ScheduleRequest.model_validate(body)).status == "infeasible"


def test_unknown_age_is_missing_input():
    body = schedule_body(); body["workers"][1]["is_minor"] = None
    result = schedule.run(ScheduleRequest.model_validate(body))
    assert result.status == "needs_input"
    assert set(result.data["missing_fields"][0]) == {"path", "label", "unit"}


def test_minor_daily_work_limit():
    body = schedule_body(); body["workers"][1]["is_minor"] = True
    result = schedule.run(ScheduleRequest.model_validate(body))
    assert result.status == "infeasible"
    # 휴게를 늘려도 7시간을 넘으면 연소자 한도 위반만 알리고, 휴게 미배치로 잘못 알리지 않는다.
    assert {v["code"] for v in result.data["violations"]} == {"MINOR_DAILY_LIMIT"}


def test_minor_auto_break_lengthens_to_fit_daily_limit():
    # 09:00~17:00 연소자: 30분 휴게면 7시간 30분 근무라 한도를 넘고, 60분이면 7시간으로 맞는다.
    body = schedule_body(); body["workers"][1]["is_minor"] = True
    for plan in body["plans"]:
        plan["shifts"] = [{"worker_key": "STAFF_1", "start_time": "09:00", "end_time": "17:00", "task_code": "ALL_TASKS", "breaks": []}]
    result = schedule.run(ScheduleRequest.model_validate(body))
    assert result.status == "ok"
    rest = result.data["plans"][0]["schedule"][0]["breaks"]
    assert sum(schedule.seconds(x["end_time"])-schedule.seconds(x["start_time"]) for x in rest) == 3600


@pytest.mark.parametrize("value", ["1٠:00", "١٢:00", "12:٣٠"])
def test_time_rejects_non_ascii_digits(value):
    body = schedule_body()
    body["plans"][0]["shifts"][0]["end_time"] = value
    with pytest.raises(ValueError):
        ScheduleRequest.model_validate(body)


def test_overlapping_shifts_bad_request_and_log(logs):
    body = schedule_body(); body["plans"][0]["shifts"].append(deepcopy(body["plans"][0]["shifts"][-1]))
    response = TestClient(app).post("/tools/labor/schedule", json=body, headers={"X-Request-Key": "bad-overlap"})
    assert response.status_code == 400
    assert response.json()["status"] == "error"
    assert logs[-1]["status"] == "failed"


def test_rest_outside_work_is_rejected(logs):
    body = cost_body()
    body["plans"][0]["shifts"][-1]["breaks"] = [{"start_time": "06:00", "end_time": "07:00", "is_paid": False}]
    assert TestClient(app).post("/tools/labor/cost", json=body).status_code == 400


def test_numeric_string_is_invalid_not_business_missing(logs):
    body = cost_body(); body["workers"][1]["hourly_wage_krw"] = "10320"
    assert TestClient(app).post("/tools/labor/cost", json=body).status_code == 400


def test_request_key_and_log_do_not_include_raw_pay_input(logs):
    response = TestClient(app).post("/tools/labor/cost", json=cost_body(), headers={"X-Request-Key": "run-1:cost"})
    assert response.status_code == 200 and response.json()["status"] == "ok"
    assert logs[-1]["request_key"] == "run-1:cost"
    assert set(logs[-1]["payload"]) == {"response_status", "plan_count", "policy_version"}


def test_unexpected_error_uses_common_500_and_logs(monkeypatch, logs):
    monkeypatch.setattr(labor_router.service, "calculate_cost", lambda body: (_ for _ in ()).throw(RuntimeError("internal")))
    response = TestClient(app, raise_server_exceptions=False).post("/tools/labor/cost", json=cost_body())
    assert response.status_code == 500
    assert response.json() == {"status": "error", "data": None, "message": "서버 오류가 발생했습니다."}
    assert logs[-1]["status"] == "failed"


def test_business_date_and_wage_year_must_match():
    body = cost_body()
    body["wage_year"] = 2027
    result = costs(body)
    assert result.status == "needs_input"
    assert result.data["detail_status"] == "WAGE_YEAR_MISMATCH"


def test_salaried_worker_is_not_silently_converted_to_hourly():
    body = cost_body()
    body["workers"][1].update(employment_type="salaried", hourly_wage_krw=None)
    assert costs(body).data["detail_status"] == "SALARIED_POLICY_REQUIRED"


def test_direct_cost_cannot_skip_break_or_minor_validation():
    body = cost_body()
    for plan in body["plans"]:
        for shift in plan["shifts"]:
            shift["breaks"] = []
    assert costs(body).status == "infeasible"
    body = cost_body()
    body["workers"][1]["is_minor"] = True
    result = costs(body)
    assert result.status == "infeasible"
    assert any(row["code"] == "MINOR_DAILY_LIMIT" for row in result.data["violations"])


def test_weekly_holiday_eligibility_uses_four_week_average():
    body = cost_body()
    body["cost_options"]["include_weekly_holiday"] = True
    body["weekly_context"] = {"workers": {key: {
        "scheduled_weekly_seconds": 40 * 3600,
        "average_weekly_scheduled_seconds": 14 * 3600,
        "scheduled_days_per_week": 5,
    } for key in ("STAFF_1", "STAFF_2")}}
    assert costs(body).data["plans"][0]["weekly_holiday_cost_krw"] == 0
    body["weekly_context"]["workers"]["STAFF_1"].pop("average_weekly_scheduled_seconds")
    assert costs(body).status == "needs_input"


def test_unknown_optional_costs_are_null_and_do_not_add_unapproved_warning_ids():
    result = costs(cost_body())
    assert result.data["warnings"] == []
    assert "주휴수당을 제외했습니다." in result.data["assumptions"]
    assert all(row["weekly_holiday_cost_krw"] is None for row in result.data["plans"])


def test_unused_worker_does_not_require_age_salary_or_pay_input():
    body = schedule_body()
    body["workers"].append({"worker_key": "UNUSED", "is_owner": False,
                            "employment_type": "salaried", "hourly_wage_krw": None})
    assert schedule.run(ScheduleRequest.model_validate(body)).status == "ok"
    body = cost_body()
    body["workers"].append({"worker_key": "UNUSED", "is_owner": False,
                            "employment_type": "salaried", "hourly_wage_krw": None})
    assert costs(body).status == "ok"
