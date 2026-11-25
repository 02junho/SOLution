"""Final selection uses completed results only (no simulation or mutation)."""
import copy
import pytest
from app.tools.simulation.roster_recommendation import recommended_choice


def option(key, waits=(145,), cost=100, hires=3, people=8, unfilled=10):
    days = dict(zip(('MON','TUE','WED','THU','FRI','SAT','SUN'), waits))
    return {'key': key, 'peak_wait_sec': days, 'plan_cost_krw': cost,
            'weekly': {'people_used': people, 'optimal': True},
            'shortfall': {'more_people_under_15h': hires, 'unfilled_hours': unfilled},
            'days': {d: {'verification': {'passes': True, 'pass_rate': 1}, 'empty_periods': []} for d in days}}


def cases(save=None, balance=None, roomy=None):
    return [save or option('SAVE'), balance or option('RECOMMENDED', (147,)),
            roomy or option('ROOMY', (139,), 125, 7)]


def test_reported_inversion_and_no_mutation():
    values = cases()
    original = copy.deepcopy(values)
    assert recommended_choice(values) == 'SAVE'
    assert values == original


def test_equal_single_day():
    assert recommended_choice(cases(balance=option('RECOMMENDED'))) == 'SAVE'


def test_balance_improvement():
    assert recommended_choice(cases(save=option('SAVE', (205,), 90), balance=option('RECOMMENDED', (167,)))) == 'RECOMMENDED'


def test_roomy_only_if_strictly_better_without_tradeoff():
    assert recommended_choice(cases(roomy=option('ROOMY', (139,)))) == 'ROOMY'
    assert recommended_choice(cases(roomy=option('ROOMY'))) == 'SAVE'


@pytest.mark.parametrize('field', ['cost', 'hires', 'people', 'unfilled'])
def test_no_increase_in_resources(field):
    values = cases(save=option('SAVE', **{field: {'cost': 101, 'hires': 4, 'people': 9, 'unfilled': 11}[field]}))
    assert recommended_choice(values) == 'RECOMMENDED'


def test_weekly_worst_not_worse():
    assert recommended_choice(cases(save=option('SAVE', (100, 190)), balance=option('RECOMMENDED', (160, 160)))) == 'RECOMMENDED'


def test_target_and_failed_pass_rate():
    values = cases()
    values[0]['days']['MON']['verification'] = {'passes': False, 'pass_rate': .7}
    assert recommended_choice(values) == 'RECOMMENDED'
    values[1]['days']['MON']['verification'] = {'passes': False, 'pass_rate': .8}
    assert recommended_choice(values) == 'RECOMMENDED'


def test_no_new_empty_period():
    values = cases()
    values[0]['days']['MON']['empty_periods'] = [{'start_time': '11:00', 'end_time': '11:30'}]
    assert recommended_choice(values) == 'RECOMMENDED'


def test_nonoptimal_assignment():
    values = cases()
    values[0]['weekly']['optimal'] = False
    assert recommended_choice(values) == 'RECOMMENDED'


@pytest.mark.parametrize('waits', [(None,), (float('nan'),), (float('inf'),), (-1,), (145, 145)])
def test_incomparable_waits(waits):
    assert recommended_choice(cases(save=option('SAVE', waits))) == 'RECOMMENDED'


def test_missing_verification_and_skipped_day():
    values = cases()
    del values[0]['days']['MON']['verification']
    assert recommended_choice(values) == 'RECOMMENDED'
    assert recommended_choice(cases(), [{'day': 'TUE'}]) == 'RECOMMENDED'


def test_display_rounding():
    assert recommended_choice(cases(save=option('SAVE', (145.4,)), balance=option('RECOMMENDED', (145.1,)))) == 'SAVE'


def test_seven_days_same_and_null_match():
    waits = (145, 148, 155, 140, 123, 180, None)
    assert recommended_choice(cases(save=option('SAVE', waits), balance=option('RECOMMENDED', waits))) == 'SAVE'


def test_plan_adds_only_selection_after_existing_calculation(monkeypatch):
    from app.tools.simulation import roster_options as ro
    calls = {'days': 0, 'assign': 0, 'hires': 0}
    views = {str(i): {'cost': {'cash_cost_krw': 100 if i < 2 else 125},
                      'peak_wait_sec': w, 'repetitions': 20,
                      'verification': {'passes': True, 'pass_rate': 1}, 'empty_periods': []}
             for i, w in enumerate((145, 147, 139))}
    recorded = {'rosters': views, 'picks': {'SAVE': 0, 'RECOMMENDED': 1, 'ROOMY': 2},
                'windows': [], 'ladder': [], 'slots': [], 'required_staff': []}
    original = copy.deepcopy(recorded)
    def run_days(*args, **kwargs):
        calls['days'] += 1
        return [('MON', recorded, None)]
    def assign(*args, **kwargs):
        calls['assign'] += 1
        return {'optimal': True, 'people_used': 8, 'unfilled': [], 'holiday_pay_krw': 0}
    def hires(*args, **kwargs):
        calls['hires'] += 1
        return []
    monkeypatch.setattr(ro, '_run_days', run_days)
    monkeypatch.setattr(ro, '_assign', assign)
    monkeypatch.setattr(ro.weekly_roster, '_workers', lambda _: [])
    monkeypatch.setattr(ro.weekly_roster, 'new_hires', hires)
    result = ro.plan({'days': [{'day': 'MON', 'roster': {}}], 'workers': [], 'compare_holiday_pay': False}, 'reference')
    assert result['recommended_choice_key'] == 'SAVE'
    assert [o['peak_wait_sec']['MON'] for o in result['options']] == [145, 147, 139]
    assert [o['plan_cost_krw'] for o in result['options']] == [100, 100, 125]
    assert result['days']['MON']['picks'] == original['picks']
    assert calls == {'days': 1, 'assign': 3, 'hires': 3}
    assert recorded == original
