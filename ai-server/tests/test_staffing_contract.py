"""공유한 역할 계약과 급여 시간의 경계. 실제 SimPy 검증을 대신하지 않는다."""
from copy import deepcopy
import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.labor import CostRequest, ScheduleRequest, Shift
from app.tools.labor.service import create_schedule, calculate_cost

DATA = Path(__file__).resolve().parents[2] / 'data/demo/operation/staffing_proposal'

def read(name):
    return json.loads((DATA / name).read_text())

def test_three_hour_support_uses_explicit_wages_and_unpaid_breaks():
    body = read('schedule_request.json')
    roster = create_schedule(ScheduleRequest.model_validate(body))
    assert roster.status == 'ok'
    assert roster.data['worker_context'] == {'A': {'is_owner': True}, 'B': {'is_owner': False}, 'C': {'is_owner': False}}
    row = next(p for p in roster.data['plans'] if p['choice_key'] == 'ALT_C')
    assert next(s for s in row['schedule'] if s['worker_key'] == 'C')['start_time'] == '11:00'
    assert next(s for s in row['schedule'] if s['worker_key'] == 'C')['end_time'] == '14:00'
    request = read('cost_request.json')
    request['plans'] = [{'choice_key': p['choice_key'], 'shifts': p['schedule']} for p in roster.data['plans']]
    result = calculate_cost(CostRequest.model_validate(request))
    rows = {p['choice_key']: p for p in result.data['plans']}
    assert rows['CURRENT']['employee_paid_seconds'] == 8 * 3600
    assert rows['CURRENT']['owner_work_seconds'] == 12 * 3600
    assert rows['ALT_C']['employee_paid_seconds'] == 11 * 3600
    assert rows['ALT_C']['cash_cost_krw'] == 113520
    assert rows['ALT_C']['additional_cash_cost_krw'] == 30960
    # 24h gross placement includes owner12h + worker9h + support3h; it is not 24h payroll.
    assert sum((int(s['end_time'][:2])-int(s['start_time'][:2])) for s in row['schedule']) == 24

def test_roles_and_support_are_preserved_not_guessed():
    body = read('schedule_request.json')
    before = deepcopy(body)
    result = create_schedule(ScheduleRequest.model_validate(body))
    a = next(p for p in result.data['plans'] if p['choice_key'] == 'ALT_A')
    row = next(s for s in a['schedule'] if s['worker_key'] == 'A' and s['start_time'] == '11:00')
    assert row['primary_role'] == 'ORDER' and row['can_support'] == ['MAKE']
    assert body == before

@pytest.mark.parametrize('change', [
    {'primary_role': None}, {'primary_role': 'MAKE'},
    {'can_support': ['ORDER']}, {'can_support': ['MAKE', 'MAKE']},
    {'task_code': 'ORDER_HANDOFF', 'primary_role': 'ORDER'},
])
def test_inconsistent_or_legacy_mixed_roles_are_rejected(change):
    row = {'worker_key': 'A', 'start_time': '07:00', 'end_time': '19:00',
           'task_code': 'ORDER', 'primary_role': 'ORDER', 'can_support': ['MAKE']}
    row.update(change)
    with pytest.raises(ValidationError):
        Shift.model_validate(row)

def test_a_b_c_do_not_imply_owner_or_wage():
    body = read('schedule_request.json')
    body['workers'][0].pop('is_owner')
    with pytest.raises(ValidationError):
        ScheduleRequest.model_validate(body)
    cost = read('cost_request.json')
    cost['workers'][1]['hourly_wage_krw'] = None
    result = calculate_cost(CostRequest.model_validate(cost))
    assert result.status == 'needs_input'
    assert result.data['missing_fields'][0]['path'] == 'workers[1].hourly_wage_krw'


def test_new_contract_requires_explicit_support_list():
    with pytest.raises(ValidationError):
        Shift.model_validate({'worker_key': 'A', 'start_time': '07:00', 'end_time': '19:00',
                              'task_code': 'ORDER', 'primary_role': 'ORDER'})
