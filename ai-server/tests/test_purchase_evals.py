"""평가 실행기의 모든 사례가 통과하는지 CI에서 확인한다. 사례·정답은 evals/purchase/cases.py."""

import pytest

from evals.purchase import run
from evals.purchase.cases import all_cases


@pytest.mark.parametrize("case", all_cases(), ids=lambda c: c["id"])
def test_평가_사례(case):
    row = run.evaluate(case)
    assert row["passed"], " / ".join(row["problems"])
