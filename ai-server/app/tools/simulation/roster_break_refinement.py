"""Roster break refinement: validate at most one break relocation per roster."""
from __future__ import annotations

import logging
from .day_window import day
from .simulation_common import summarize
from .slot_plan import slot_pass_rate

log = logging.getLogger('uvicorn.error')


def _signature(shifts):
    return tuple((s['worker_key'], s['start_time'], s['end_time'],
                  tuple((b['start_time'], b['end_time']) for b in s['breaks'])) for s in shifts)


def _coverage(rows, ctx, need, windows):
    from .daily_roster import UNIT
    d = day()
    busy = {i for w in windows for i in w['slots']}
    edges = [d.rel(t) for t in d.edges]
    orders = ctx['scn']['orders_by_slot']
    empty = set()
    deficit = peak_deficit = pressure = 0
    for u, target in enumerate(need):
        at = u * UNIT
        i = next(i for i, (a,b) in enumerate(zip(edges, edges[1:])) if a <= at < b)
        n = min(r['staff_count'] for r in rows if r['start_sec'] < at+UNIT and r['end_sec'] > at)
        lack = max(0, target - n)
        rate = orders[d.slots[i]] * 3600 / (edges[i+1] - edges[i])
        if n == 0:
            empty.add(u)
        deficit += lack * lack
        peak_deficit += lack * lack if i in busy else 0
        pressure += rate / max(1,n)
    return empty, (deficit, peak_deficit, round(pressure, 6))


def _metrics(records, windows, limit):
    from .daily_roster import _day_rate, _slot_p90
    slots = [_slot_p90(records, i) for i in range(len(day().slots))]
    waits = [max((slots[i] for i in w['slots'] if slots[i] is not None), default=None) for w in windows]
    return (waits, summarize([r['p90_post_order_receipt_sec'] for r in records])['mean'],
            _day_rate(records, limit),
            [slot_pass_rate(records, i, limit) for i in range(len(slots))],
            tuple(r['completed_eventually'] for r in records))


def _no_worse(a,b):
    return (a is None and b is None) or (a is not None and b is not None and a <= b)


def _acceptable(candidate, baseline, threshold):
    aw, ad, ar, ass, ac = candidate
    bw, bd, br, bss, bc = baseline
    if not all(_no_worse(a,b) for a,b in zip(aw,bw)) or not _no_worse(ad,bd) or ar < br:
        return False
    if any((a is None) != (b is None) or (b is not None and b >= threshold and a < threshold)
           for a,b in zip(ass,bss)) or any(a < b for a,b in zip(ac,bc)):
        return False
    a = max((x for x in aw if x is not None), default=None)
    b = max((x for x in bw if x is not None), default=None)
    return a is not None and b is not None and b-a >= 1.0


def _coverage_acceptable(empty, score, original_empty, baseline_score):
    # Compare independently: lexicographic comparison can hide a worse peak deficit.
    return (empty <= original_empty and score[0] <= baseline_score[0]
            and score[1] <= baseline_score[1])


def refine(shifts, ctx, need, windows):
    from .daily_roster import UNIT, _shift_rows, _check_breaks, _cost, _hhmm
    if not windows:
        return shifts
    d = day()
    run = ctx['run']
    original_rows = _shift_rows(shifts)
    original_empty, baseline_score = _coverage(original_rows,ctx,need,windows)
    candidates = []
    # Only existing contiguous breaks; preserve paid time and shift spans.
    for i,s in enumerate(shifts):
        if s['is_owner'] or len(s['breaks']) != 1:
            continue
        a,b = d.rel(s['start_time']), d.rel(s['end_time'])
        x,y = (d.rel(s['breaks'][0][k]) for k in ('start_time','end_time'))
        if any(v % UNIT for v in (a,b,x,y)):
            continue
        length = y-x
        if length <= 0:
            continue
        margin = 2*UNIT if b-a >= length+4*UNIT else UNIT
        for start in range(a+margin,b-margin-length+1,UNIT):
            if start == x:
                continue
            trial = list(shifts)
            trial[i] = {**s,'breaks':[{'start_time':_hhmm(start),'end_time':_hhmm(start+length)}]}
            empty, score = _coverage(_shift_rows(trial),ctx,need,windows)
            if not _coverage_acceptable(empty, score, original_empty, baseline_score):
                continue
            candidates.append((score,i,start,trial))
    if not candidates:
        return shifts
    candidates.sort(key=lambda c:c[:3])
    baseline = _metrics(run(original_rows), windows, ctx['limit'])
    best, best_metrics = shifts, baseline
    original_cost = _cost(shifts,ctx['wage'],ctx['business_date'],ctx['minor'])
    tested = 0
    for _,_,_,candidate in candidates[:1]:
        try:
            validated = _check_breaks(candidate,ctx['wage'],ctx['business_date'],ctx['minor'],d.peak)
            if _signature(validated) != _signature(candidate) or _cost(validated,ctx['wage'],ctx['business_date'],ctx['minor']) != original_cost:
                continue
        except ValueError:
            continue
        tested += 1
        metrics = _metrics(run(_shift_rows(validated)),windows,ctx['limit'])
        if _acceptable(metrics,best_metrics,ctx['need_rate']):
            best,best_metrics = validated,metrics
    log.info('roster break refinement tested=%s accepted=%s waits_before=%s waits_after=%s',tested,best is not shifts,baseline[0],best_metrics[0])
    return best
