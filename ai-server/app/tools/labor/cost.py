"""실제 시급 × 검증된 유급시간. 대기 통계·추천은 계산하지 않는다."""

from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from app.core.response import needs_input, ok
from app.tools.labor import policies
from app.tools.labor.schedule import run as check_schedule
from app.tools.labor.schedule import seconds, validate_intervals
from app.schemas.labor import CostRequest, ScheduleRequest


def won(value: Decimal) -> int:
    return int(value.quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _missing(path: str, label: str, unit=None) -> dict:
    return {"path": path, "label": label, "unit": unit}


def _valid_insurance_policy(policy, year):
    if not policy or policy.get("year") != year or not policy.get("source_ref"):
        return False
    try:
        rates = [Decimal(str(policy["rates"][key])) for key in policies.INSURANCE_COMPONENTS]
        return all(rate.is_finite() and 0 <= rate <= 1 for rate in rates)
    except (KeyError, TypeError, InvalidOperation):
        return False


def run(body: CostRequest):
    validate_intervals(body)
    if body.business_date.year != body.wage_year:
        return needs_input({"detail_status": "WAGE_YEAR_MISMATCH", "missing_fields": [
            _missing("wage_year", "영업일과 같은 시급 적용 연도")
        ]}, "계산할 영업일과 시급 적용 연도를 맞춰 주세요.")
    minimum = policies.MINIMUM_WAGES.get(body.wage_year)
    if minimum is None:
        return needs_input({"detail_status": "UNKNOWN_WAGE_POLICY", "missing_fields": [
            _missing("wage_year", "확인된 시급 적용 연도", "년")]}, "등록된 연도별 최저시급 정책을 확인해 주세요.")
    used_workers = {s.worker_key for p in body.plans for s in p.shifts}
    employees = [w for w in body.workers if not w.is_owner and w.worker_key in used_workers]
    missing = [_missing(f"workers[{i}].hourly_wage_krw", f"{w.worker_key} 실제 시급", "원")
               for i, w in enumerate(body.workers)
               if not w.is_owner and w.employment_type == "hourly" and w.worker_key in used_workers and
               (w.hourly_wage_krw is None or w.hourly_wage_krw < minimum)]
    if missing:
        return needs_input({"detail_status": "WAGE_INPUT_REQUIRED", "missing_fields": missing},
                           f"실제 시급을 확인해 주세요. {body.wage_year}년 최저시급({minimum:,}원)보다 낮은 값을 임의로 올려 계산하지 않습니다.")

    salaried = [_missing(f"workers[{i}].employment_type", "정규직·고정급 적용 범위")
                for i, worker in enumerate(body.workers)
                if not worker.is_owner and worker.worker_key in used_workers and worker.employment_type == "salaried"]
    if salaried:
        return needs_input({"detail_status": "SALARIED_POLICY_REQUIRED", "missing_fields": salaried},
                           "정규직 급여·배치 범위가 미확정입니다. 고정급을 시급이나 절감액으로 자동 환산하지 않습니다.")

    if body.cost_options.include_weekly_holiday:
        if body.weekly_context is None:
            missing.append(_missing("weekly_context", "주간 근무 조건"))
        else:
            for worker in employees:
                ctx = body.weekly_context.workers.get(worker.worker_key)
                if ctx is None or ctx.average_weekly_scheduled_seconds is None or (ctx.average_weekly_scheduled_seconds >= 15*3600 and
                                   (ctx.attended_all_scheduled_days is None or ctx.employment_continues_through_holiday is None)):
                    missing.append(_missing(f"weekly_context.workers.{worker.worker_key}", f"{worker.worker_key} 소정근로·개근·재직 조건"))
    insurance_policy = None
    if body.cost_options.include_employer_insurance:
        if body.insurance_context is not None:
            insurance_policy = policies.APPROVED_INSURANCE_POLICIES.get(body.insurance_context.policy_version)
        if not _valid_insurance_policy(insurance_policy, body.wage_year):
            missing.append(_missing("insurance_context", "검토된 보험별 사업주 부담 정책"))
        else:
            for worker in employees:
                ctx = body.insurance_context.workers.get(worker.worker_key)
                if ctx is None or any(ctx.applies.get(k) is None for k in policies.INSURANCE_COMPONENTS):
                    missing.append(_missing(f"insurance_context.workers.{worker.worker_key}", f"{worker.worker_key} 보험별 적용 여부"))
    if missing:
        return needs_input({"detail_status": "MISSING_COST_CONTEXT", "missing_fields": missing},
                           "선택한 비용 옵션에 필요한 근무 조건·보험 정책을 확인해 주세요. 미확인을 0원으로 처리하지 않습니다.")

    # /cost를 직접 부르더라도 근무 정책을 우회하지 않는다. 휴게를 새로 만들지 않고 검사만 한다.
    checked = check_schedule(ScheduleRequest(
        session_id=body.session_id, input_version_id=body.input_version_id,
        business_date=body.business_date, workers=body.workers, plans=body.plans,
        auto_break=False, rule_policy_version=f"labor.kr.{body.wage_year}.v1"))
    if checked.status != "ok":
        return checked

    estimates = []
    for plan in body.plans:
        paid = {}
        worked = {}
        owner_seconds = 0
        for shift in plan.shifts:
            duration = seconds(shift.end_time)-seconds(shift.start_time)
            actual = duration-sum(seconds(b.end_time)-seconds(b.start_time) for b in shift.breaks)
            duration -= sum(seconds(b.end_time)-seconds(b.start_time) for b in shift.breaks if not b.is_paid)
            paid[shift.worker_key] = paid.get(shift.worker_key, 0)+duration
            worked[shift.worker_key] = worked.get(shift.worker_key, 0)+actual
        daily_workers = []
        for worker in body.workers:
            duration = paid.get(worker.worker_key, 0)
            if worker.is_owner:
                owner_seconds += worked.get(worker.worker_key, 0)
                continue
            if duration == 0:
                continue
            base = won(Decimal(duration)*worker.hourly_wage_krw/3600)
            holiday = None
            if body.cost_options.include_weekly_holiday:
                ctx = body.weekly_context.workers[worker.worker_key]
                eligible = ctx.average_weekly_scheduled_seconds >= 15*3600 and ctx.attended_all_scheduled_days and ctx.employment_continues_through_holiday
                # 주40시간·5일 통상근로자와 비교한 주휴의 일별 배분 추정.
                weekly_holiday = Decimal(ctx.scheduled_weekly_seconds)/5*worker.hourly_wage_krw/3600 if eligible else Decimal(0)
                holiday = won(weekly_holiday/ctx.scheduled_days_per_week)
            insurance = None
            if body.cost_options.include_employer_insurance:
                applies = body.insurance_context.workers[worker.worker_key].applies
                rates = insurance_policy["rates"]
                # 요율은 서버 검토 정책에서만 읽으며 클라이언트가 보낸 숫자를 쓰지 않는다.
                applicable_base = Decimal(base+(holiday or 0))
                insurance = sum(won(applicable_base*Decimal(str(rates[k])))
                                for k in policies.INSURANCE_COMPONENTS if applies[k])
            cash = base+(holiday or 0)+(insurance or 0)
            daily_workers.append({"worker_key": worker.worker_key, "paid_seconds": duration,
                                  "base_wage_krw": base, "weekly_holiday_cost_krw": holiday,
                                  "employer_insurance_cost_krw": insurance, "cash_cost_krw": cash})
        monthly = body.monthly_projection
        projectable = monthly is not None and all(w["worker_key"] in monthly.worker_days_per_week for w in daily_workers)
        week_base = sum(w["base_wage_krw"]*monthly.worker_days_per_week[w["worker_key"]] for w in daily_workers) if projectable else None
        week_cash = sum(w["cash_cost_krw"]*monthly.worker_days_per_week[w["worker_key"]] for w in daily_workers) if projectable else None
        row = {"choice_key": plan.choice_key,
               "employee_paid_seconds": sum(w["paid_seconds"] for w in daily_workers), "owner_work_seconds": owner_seconds,
               "base_wage_krw": sum(w["base_wage_krw"] for w in daily_workers),
               "weekly_holiday_cost_krw": sum(w["weekly_holiday_cost_krw"] for w in daily_workers) if body.cost_options.include_weekly_holiday else None,
               "employer_insurance_cost_krw": sum(w["employer_insurance_cost_krw"] for w in daily_workers) if body.cost_options.include_employer_insurance else None,
               "cash_cost_krw": sum(w["cash_cost_krw"] for w in daily_workers),
               "weekly_base_wage_estimate_krw": week_base,
               "monthly_cash_cost_estimate_krw": won(Decimal(week_cash)*monthly.weeks_per_month) if projectable else None,
               "cost_scope": "WITH_SELECTED_OPTIONS" if body.cost_options.include_weekly_holiday or body.cost_options.include_employer_insurance else "BASE_WAGE_ONLY",
               "workers": daily_workers}
        estimates.append(row)
    baseline = next(row for row in estimates if row["choice_key"] == "CURRENT")
    for row in estimates:
        row["additional_cash_cost_krw"] = row["cash_cost_krw"]-baseline["cash_cost_krw"]
        row["additional_monthly_cash_cost_estimate_krw"] = (row["monthly_cash_cost_estimate_krw"]-baseline["monthly_cash_cost_estimate_krw"]
                                                            if row["monthly_cash_cost_estimate_krw"] is not None and baseline["monthly_cash_cost_estimate_krw"] is not None else None)
    assumptions = ["입력 시급과 유급시간으로 계산한 계획 비용입니다. 실제 급여 정산서가 아닙니다."]
    if not body.cost_options.include_weekly_holiday:
        assumptions.append("주휴수당을 제외했습니다.")
    if not body.cost_options.include_employer_insurance:
        assumptions.append("사업주 부담 보험료를 제외했습니다.")
    if body.cost_options.include_weekly_holiday:
        assumptions.append("주휴는 입력한 4주 평균 소정근로시간·개근·재직 조건을 사용하고, 주40시간·5일 비교 패턴으로 계획 근무일에 배분한 추정치입니다.")
        if any(body.weekly_context.workers[w.worker_key].average_weekly_scheduled_seconds >= 15*3600
               and body.weekly_context.workers[w.worker_key].attended_all_scheduled_days
               and body.weekly_context.workers[w.worker_key].employment_continues_through_holiday for w in employees):
            assumptions.append("주휴 반영 대상은 개근 가정과 주휴일까지의 재직 조건을 확인한 직원입니다.")
    if body.cost_options.include_employer_insurance:
        assumptions.append("보험료는 검토된 사업주 부담 환산요율에 따른 일할 추정치입니다. 가입 특례·보수 한도·정산은 별도 확인 대상입니다.")
    if body.monthly_projection:
        assumptions.append(f"월 {body.monthly_projection.weeks_per_month}주와 직원별 주간 반복 패턴을 가정한 월 추정치입니다.")
    # 공통 가드레일의 확정 경고 ID는 SIMULATED_CONDITIONS/VAT_UNKNOWN뿐이다.
    # 비용 제외·휴게·급여 추정의 구체적 조건은 cost_scope와 assumptions에 보존한다.
    return ok({"session_id": body.session_id, "input_version_id": body.input_version_id, "wage_year": body.wage_year,
               "minimum_hourly_wage_krw": int(minimum), "assumptions_version": body.assumptions_version,
               "monthly_estimation_method": "REPEATED_WEEK_FACTOR" if body.monthly_projection else None,
               "weeks_per_month": float(body.monthly_projection.weeks_per_month) if body.monthly_projection else None,
               "plans": estimates, "warnings": [], "assumptions": assumptions})
