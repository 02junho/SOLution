"""연소자 긴 조: 입력을 먼저 검사하고(범위·30분 단위), 그다음 7.5시간으로 줄인다."""

import pytest

from app.tools.simulation.daily_roster import _rules


def test_연소자도_잘못된_긴_조_입력은_거절한다():
    for bad in (11, 7.25, "8"):
        with pytest.raises(ValueError):
            _rules({"roster_rules": {"long_shift_hours": bad}}, minor=True)


def test_연소자_8시간은_7시간_30분으로_줄인다():
    assert _rules({"roster_rules": {"long_shift_hours": 8}}, minor=True)["long_shift_hours"] == 7.5
    assert _rules({}, minor=True)["long_shift_hours"] == 7.5
    assert _rules({"roster_rules": {"long_shift_hours": 6}}, minor=True)["long_shift_hours"] == 6
    assert _rules({"roster_rules": {"long_shift_hours": 8}})["long_shift_hours"] == 8
