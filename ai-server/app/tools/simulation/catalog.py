"""고칠 수 있는 모델 입력(메뉴·제조 단계). 가게·레시피 DB와는 따로 관리한다."""

from __future__ import annotations
import copy
import json
import math
from pathlib import Path

from .day_window import CLOSE_RANGE, OPEN_RANGE, STEP_MIN

FILE = Path(__file__).with_name("menu_catalog.json")
BASE = json.loads(FILE.read_text("utf-8"))
PLAN_IDS = ("CURRENT", "ALT_A", "ALT_C")
SLOTS = ("07:00-11:00", "11:00-14:00", "14:00-17:00", "17:00-19:00")
TEST_LOADS = (60, 100, 150, 276)
EQUIPMENT = ("espresso", "steam", "blender")


def _real(v, name, *, lower=0, upper=1e6):
    if type(v) not in (int, float) or not math.isfinite(v) or not lower <= v <= upper:
        raise ValueError(f"{name} must be a finite number in [{lower}, {upper}]")
    return float(v)


def validate_menus(menus):
    if not isinstance(menus, list) or not 1 <= len(menus) <= 10:
        raise ValueError("selected_menus must contain 1..10 menus")
    ids = [m.get("menu_id") for m in menus]
    if len(set(ids)) != len(ids) or any(not isinstance(i, str) or not i for i in ids):
        raise ValueError("menu_id must be unique nonempty strings")
    for m in menus:
        _real(m.get("sales_weight"), f"{m['menu_id']}.sales_weight", upper=1)
        _real(m.get("manufacture_sec"), f"{m['menu_id']}.manufacture_sec", lower=1)
        _real(
            m.get("manufacture_stddev_sec"),
            f"{m['menu_id']}.manufacture_stddev_sec",
            upper=300,
        )
        steps = m.get("steps")
        if not isinstance(steps, list) or not steps:
            raise ValueError("steps must be nonempty")
        for step in steps:
            if not isinstance(step, dict):
                raise ValueError("step must be an object")
            # 장비 없는 단계는 equipment를 빼고 보내도 된다. 엔진이 키를 바로 읽으므로 None으로 채운다.
            step.setdefault("equipment", None)
            _real(step.get("duration_sec"), "step.duration_sec", lower=0.1)
            if type(step.get("worker")) is not bool:
                raise ValueError("step.worker must be boolean")
            if step.get("equipment") not in (*EQUIPMENT, None):
                raise ValueError("Unknown equipment")
            if not step["worker"] and step["equipment"] is None:
                raise ValueError("A step requires a worker or equipment")
        if not math.isclose(
            sum(s["duration_sec"] for s in steps), m["manufacture_sec"], abs_tol=1e-6
        ):
            raise ValueError(
                f"{m['menu_id']}: sum(steps.duration_sec) != manufacture_sec"
            )
    if not math.isclose(sum(m["sales_weight"] for m in menus), 1.0, abs_tol=1e-8):
        raise ValueError("selected_menus sales_weight must sum to 1.0")
    return menus


def _scale_menu(menu, total):
    """가게가 잰 한 잔 제조시간(초)으로 바꾼다. 단계 비율(사람 단계·기계 단계)과 흔들림 비율은 그대로 둔다."""
    factor = total / menu["manufacture_sec"]
    for step in menu["steps"]:
        step["duration_sec"] = step["duration_sec"] * factor
    menu["manufacture_stddev_sec"] = min(300.0, menu["manufacture_stddev_sec"] * factor)
    menu["manufacture_sec"] = sum(step["duration_sec"] for step in menu["steps"])
    menu["manufacture_sec_source"] = "STORE_ENTERED"


def config_for(body):
    if not isinstance(body, dict):
        raise ValueError("JSON request must be object")
    config = copy.deepcopy(BASE)
    if body.get("selected_menus") is not None:
        requested = body["selected_menus"]
        if not isinstance(requested, list):
            raise ValueError("selected_menus must be list")
        byid = {m["menu_id"]: m for m in config["menus"]}
        selected = []
        for entry in requested:
            if not isinstance(entry, dict) or entry.get("menu_id") not in byid:
                raise ValueError("Unknown menu_id")
            m = copy.deepcopy(byid[entry["menu_id"]])
            m.update(entry)
            selected.append(m)
    else:
        ids = body.get("selected_menu_ids", config["selected_menu_ids"])
        if not isinstance(ids, list) or len(ids) != len(set(ids)):
            raise ValueError("selected_menu_ids must be unique menu IDs")
        byid = {m["menu_id"]: m for m in config["menus"]}
        try:
            selected = [copy.deepcopy(byid[i]) for i in ids]
        except (KeyError, TypeError) as exc:
            raise ValueError("Unknown menu_id") from exc
    weights = body.get("menu_weights")
    if weights is not None:
        if not isinstance(weights, dict) or set(weights) != {
            m["menu_id"] for m in selected
        }:
            raise ValueError("menu_weights keys must exactly match selected menus")
        for m in selected:
            m["sales_weight"] = weights[m["menu_id"]]
    times = body.get("manufacture_sec_by_menu")
    if times is not None:
        if not isinstance(times, dict) or set(times) - {m["menu_id"] for m in selected}:
            raise ValueError("manufacture_sec_by_menu keys must be selected menus")
        for m in selected:
            if m["menu_id"] in times:
                _scale_menu(m, _real(times[m["menu_id"]], f"{m['menu_id']}.manufacture_sec", lower=10, upper=600))
    validate_menus(selected)
    durations = _real(
        body.get("manufacture_duration_scale", 1),
        "manufacture_duration_scale",
        lower=0.1,
        upper=3.0,
    )
    variability = _real(
        body.get("manufacture_variability_scale", 1),
        "manufacture_variability_scale",
        upper=3.0,
    )
    equipment = body.get("equipment_counts", config["equipment_counts"])
    if (
        not isinstance(equipment, dict)
        or set(equipment) != set(EQUIPMENT)
        or any(type(v) != int or not 1 <= v <= 3 for v in equipment.values())
    ):
        raise ValueError(
            "equipment_counts must contain integer capacity 1..3 for espresso/steam/blender"
        )
    config["menus"] = copy.deepcopy(selected)  # Public JSON contract, with _sec units
    config["equipment_counts"] = copy.deepcopy(equipment)
    for key, default in [
        ("order_time_sec", 60),
        ("order_stddev_sec", 15),
        ("handoff_time_sec", 30),
        ("handoff_stddev_sec", 10),
        ("takeout_extra_handoff_sec", 0),
    ]:
        config[key] = _real(
            body.get(key, default),
            key,
            lower=0 if "stddev" in key or "extra" in key else 1,
            upper=300,
        )
    config["manufacture_duration_scale"] = durations
    config["manufacture_variability_scale"] = variability
    # 내부 계산기도 공개 JSON과 같은 *_sec 이름을 쓴다. 공정 단계 시간만 엔진 내부 키 seconds로 바꾼다.
    internal = copy.deepcopy(selected)
    for m in internal:
        for step in m["steps"]:
            step["seconds"] = step.pop("duration_sec")
    config["catalog"] = {
        "menus": internal,
        "equipment_counts": copy.deepcopy(equipment),
    }
    return config


def options():
    return {
        "model_version": "operation.v1",
        "execution_mode": "continuous_day",
        "time_slots": list(SLOTS),
        "open_time_range": list(OPEN_RANGE),
        "close_time_range": list(CLOSE_RANGE),
        "time_step_min": STEP_MIN,
        "choice_keys": list(PLAN_IDS),
        "test_loads": list(TEST_LOADS),
        "default_repetitions": 30,
        "equipment_counts": copy.deepcopy(BASE["equipment_counts"]),
        "selected_menus": [
            copy.deepcopy(m)
            for m in BASE["menus"]
            if m["menu_id"] in BASE["selected_menu_ids"]
        ],
        "menu_candidates": [
            {"menu_id": m["menu_id"], "menu_name": m["menu_name"]}
            for m in BASE["menus"]
        ],
        "assumption_notice": "Menu shares and manufacture times are estimates; not actual store observations.",
    }
