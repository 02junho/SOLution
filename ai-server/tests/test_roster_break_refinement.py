"""Regression tests for the default roster-only break search."""
import json
from pathlib import Path

import pytest

from app.tools.simulation import roster_options as ro
from app.tools.simulation import roster_break_refinement as refinement


def test_cache_key_is_independent_of_old_flag(monkeypatch):
    job = ('SAT', {'business_date': '2026-11-24'}, 'reference', 30, False)
    monkeypatch.delenv('ROSTER_BREAK_EXPERIMENT', raising=False)
    default_key = ro._job_key(job)
    monkeypatch.setenv('ROSTER_BREAK_EXPERIMENT', '0')
    assert ro._job_key(job) == default_key
    assert default_key != ro.day_cache.key(
        'roster_options.day.v3', job[1], job[2], job[3], job[4], ro.SHORT_RULES, ro.LONG_RULES
    )


BASE = ([180., 200.], 170., .8, [.85,.9], (20,20))


@pytest.mark.parametrize('candidate,expected', [
    (([170., 190.], 160., .9, [.9,.9], (20,20)), True),
    (([181., 150.], 150., .9, [.9,.9], (20,20)), False),
    (([170., 190.], 171., .9, [.9,.9], (20,20)), False),
    (([170., 190.], 160., .75, [.9,.9], (20,20)), False),
    (([170., 190.], 160., .9, [.75,.9], (20,20)), False),
    (([170., 190.], 160., .9, [.9,.9], (19,20)), False),
    (([180., 199.5], 160., .9, [.9,.9], (20,20)), False),
    (([None, 190.], 160., .9, [.9,.9], (20,20)), False),
])
def test_acceptance_protects_other_metrics(candidate, expected):
    assert refinement._acceptable(candidate, BASE, .8) is expected


def _spans(view):
    return [(s['worker_key'], s['start_time'], s['end_time'],s['break_minutes'],s['span_hours']) for s in view['shifts']]


def test_real_saturday_regression(monkeypatch):
    from app.schemas.simulation import RosterOptionsDayRequest

    path = Path(__file__).parent / 'data' / 'roster_break_saturday.json'
    day = RosterOptionsDayRequest.model_validate(
        json.loads(path.read_text(encoding='utf-8'))
    ).model_dump(exclude_none=True)
    # Disable the refinement only inside this test to obtain the original baseline.
    with monkeypatch.context() as m:
        m.setattr(refinement, 'refine', lambda shifts, ctx, need, windows: shifts)
        base = ro.day_options(day, 'reference', holiday=False)
    monkeypatch.delenv('ROSTER_BREAK_EXPERIMENT', raising=False)
    revised = ro.day_options(day, 'reference', holiday=False)
    for key in ('windows','required_staff','slots','ladder','picks'):
        assert revised[key] == base[key]
    for k,view in revised['rosters'].items():
        old = base['rosters'][k]
        assert _spans(view) == _spans(old)
        assert view['cost'] == old['cost']
        assert view['peak_wait_sec'] <= old['peak_wait_sec']
        assert view['verification']['pass_rate'] >= old['verification']['pass_rate']
        assert view['verification']['p90_post_order_receipt_sec'] <= old['verification']['p90_post_order_receipt_sec']
        assert all(w in old['empty_periods'] for w in view['empty_periods'])
    assert base['rosters']['1']['peak_wait_sec'] - revised['rosters']['1']['peak_wait_sec'] > 50


def test_coverage_compares_peak_and_total_independently():
    assert not refinement._coverage_acceptable(set(), (4, 3, 1), set(), (5, 2, 1))
    assert not refinement._coverage_acceptable(set(), (6, 1, 1), set(), (5, 2, 1))
    assert not refinement._coverage_acceptable({1}, (4, 1, 1), set(), (5, 2, 1))
    assert refinement._coverage_acceptable(set(), (4, 2, 1), set(), (5, 2, 1))


def test_no_breaks_never_runs_extra_simulation():
    shifts = [{'worker_key': 'OWNER', 'is_owner': True, 'start_time': '07:00',
               'end_time': '19:00', 'breaks': []}]
    from app.tools.simulation.day_window import day
    d = day()
    def forbidden(_):
        pytest.fail('No candidate should require simulation')
    ctx = {'run': forbidden, 'scn': {'orders_by_slot': dict.fromkeys(d.slots, 10)}}
    assert refinement.refine(shifts, ctx, [1] * (d.length // 1800), [{'slots': [0]}]) is shifts
