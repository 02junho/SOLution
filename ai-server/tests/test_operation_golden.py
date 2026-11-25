"""기본값이면 결과가 같다: 지금 계산 결과를 기준 파일과 비교한다.

가게 데이터 입력·영업시간·근무표 생성을 붙여도, 새 값을 안 넣으면 결과가 그대로여야 한다.
결과가 바뀌는 게 맞는 변경이면 기준 파일을 다시 만들고(operation_golden_cases.py) 이유를 PR에 적는다.
"""

import json

import pytest

from tests.operation_golden_cases import CASES, GOLDEN, summary


@pytest.mark.parametrize("name", list(CASES))
def test_default_inputs_keep_results(name):
    expected = json.loads(GOLDEN.read_text(encoding="utf-8"))[name]
    _same(summary(name), expected)


def _same(actual, expected, path="$"):
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and set(actual) == set(expected), path
        for k in expected:
            _same(actual[k], expected[k], f"{path}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), path
        for i, (a, e) in enumerate(zip(actual, expected)):
            _same(a, e, f"{path}[{i}]")
    elif isinstance(expected, float):
        assert actual == pytest.approx(expected, abs=1e-6), path
    else:
        assert actual == expected, path
    return True
