"""Evaluate completed roster options; never recalculate or mutate a roster."""
from math import floor, isfinite


def _number(value):
    return type(value) in (int, float) and isfinite(value) and value >= 0


def _rounded(value):
    # Same non-negative seconds rounding as the UI (Math.round).
    return floor(value + 0.5)


def _metrics(option):
    waits = option['peak_wait_sec']
    values = [v for v in waits.values() if v is not None]
    if not values or not all(_number(v) for v in values):
        return None
    metrics = (
        _rounded(sum(values) / len(values)), _rounded(max(values)),
        option['plan_cost_krw'], option['weekly']['people_used'],
        option['shortfall']['more_people_under_15h'], option['shortfall']['unfilled_hours'],
    )
    return metrics if all(_number(v) for v in metrics) else None


def _dominates(candidate, current, allow_tie):
    """Replace only when comparable and no evaluated dimension worsens."""
    try:
        a, b = candidate['peak_wait_sec'], current['peak_wait_sec']
        ad, bd = candidate['days'], current['days']
        if not a or a.keys() != b.keys() or a.keys() != ad.keys() or ad.keys() != bd.keys():
            return False
        if any((a[d] is None) != (b[d] is None) for d in a):
            return False
        # Do not switch automatically to an unproven employee assignment.
        if candidate['weekly'].get('optimal') is not True:
            return False
        for day in ad:
            av, bv = ad[day]['verification'], bd[day]['verification']
            ap, bp = av['passes'], bv['passes']
            if type(ap) is not bool or type(bp) is not bool or (bp and not ap):
                return False
            if not ap and not bp:
                ar, br = av['pass_rate'], bv['pass_rate']
                if not (_number(ar) and _number(br) and ar >= br):
                    return False
            ae, be = ad[day]['empty_periods'], bd[day]['empty_periods']
            if not isinstance(ae, list) or not isinstance(be, list) or any(p not in be for p in ae):
                return False
        am, bm = _metrics(candidate), _metrics(current)
        return (am is not None and bm is not None and all(x <= y for x, y in zip(am, bm))
                and (allow_tie or am != bm))
    except (KeyError, TypeError, AttributeError, ValueError, OverflowError):
        # Incomplete or incomparable results cannot justify switching.
        return False


def recommended_choice(options, skipped_days=()):
    """Keep the existing balance choice unless another completed plan dominates it.

    SAVE wins ties; ROOMY needs a strict improvement with no additional cost,
    hiring, shortfall or rounded average/worst wait. No new simulation/solver.
    The 30-second daily experiment criterion is deliberately unchanged.
    """
    by_key = {o['key']: o for o in options}
    best = by_key['RECOMMENDED']
    if not skipped_days:
        for key in ('SAVE', 'ROOMY'):
            candidate = by_key[key]
            if _dominates(candidate, best, allow_tie=key == 'SAVE'):
                best = candidate
    return best['key']
