import json

import pytest

from app.tools.simulation.menu_types import classify

TYPES = [{"id": "iced_americano", "label": "커피 · 아이스"}, {"id": "blueberry_yogurt_smoothie", "label": "블렌더 음료"}]


def test_목록_밖_답은_버리고_FOOD는_받는다():
    seen = {}

    def call(system, user):
        seen["user"] = json.loads(user)
        return json.dumps({"시그니처 X": "blueberry_yogurt_smoothie", "굿즈 Y": "FOOD", "Z": "hot_latte"})

    out = classify({"names": ["시그니처 X", "굿즈 Y", "Z", "Z"], "types": TYPES}, call=call)
    assert out["source"] == "LLM"
    assert out["types"] == {"시그니처 X": "blueberry_yogurt_smoothie", "굿즈 Y": "FOOD", "Z": None}
    # 유형 목록은 데이터로 넘긴다(FOOD 포함), 이름은 중복 없이.
    assert [t["id"] for t in seen["user"]["types"]][-1] == "FOOD"
    assert seen["user"]["names"] == ["시그니처 X", "굿즈 Y", "Z"]


def test_키가_없거나_이상한_답이면_모두_모름():
    assert classify({"names": ["A"], "types": TYPES}, call=lambda s, u: None)["source"] == "UNAVAILABLE"
    out = classify({"names": ["A"], "types": TYPES}, call=lambda s, u: "모르겠어요")
    assert out == {"model_version": "operation.menu_types.v1", "source": "UNAVAILABLE", "types": {"A": None}}
    assert classify({"names": ["A"], "types": TYPES}, call=lambda s, u: '```json\n{"A": "iced_americano"}\n```')["types"] == {"A": "iced_americano"}

    # 분류값이 목록·사전이어도 죽지 않고 모름으로 본다
    weird = classify({"names": ["A", "B"], "types": TYPES}, call=lambda s, u: '{"A": ["FOOD"], "B": {"x": 1}}')
    assert weird["types"] == {"A": None, "B": None}


def test_입력_검사():
    with pytest.raises(ValueError):
        classify({"names": [], "types": TYPES}, call=lambda s, u: None)
    with pytest.raises(ValueError):
        classify({"names": ["가" * 41], "types": TYPES}, call=lambda s, u: None)
    with pytest.raises(ValueError):
        classify({"names": ["A"], "types": [{"id": 1}]}, call=lambda s, u: None)
