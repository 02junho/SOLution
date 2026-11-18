"""Developer sensitivity report (Markdown). Not an API; run from ai-server/:

    PYTHONPATH=. python scripts/simulation_report.py --daily-orders 150 --engine simpy --out sensitivity_report.md

Basis = the per-slot recommendation the owner sees. For demand ±20% and manufacture ±20% the
per-slot plan is recomputed and the baseline slot combination is re-verified; meaningful = a slot
choice changes or that combination stops meeting the target. Other conditions are developer-only
and judged on the day-level three-plan recommendation. Changes carry the paired 95% interval
(CMP-002): an interval that includes 0 is "차이 없음".
"""

from __future__ import annotations
import argparse
import json
from pathlib import Path

from app.tools.simulation.simulation_service import PLAN_TITLES, sensitivity

LABELS = {
    "demand_scale": lambda v: f"하루 주문량 ×{v:g}",
    "manufacture_duration_scale": lambda v: f"제조시간 ×{v:g}",
    "manufacture_variability_scale": lambda v: f"제조시간 편차 ×{v:g}",
    "order_time_sec": lambda v: f"주문·결제 {v:g}초",
    "handoff_time_sec": lambda v: f"전달 {v:g}초",
}
VERDICT = {
    "better": "빨라짐",
    "worse": "느려짐",
    "no_difference": "차이 없음",
    "not_available": "계산 불가",
}


def _sec(value):
    return "—" if value is None else f"{value:.1f}초"


def _rate(value):
    return "—" if value is None else f"{value * 100:.0f}%"


def _title(key):
    return PLAN_TITLES.get(key, key or "없음")


def _label(row):
    return LABELS.get(row["dimension"], lambda v: f"{row['dimension']}={v:g}")(
        row["value"]
    )


def _slots(keys):
    return " · ".join(
        f"{slot[:2].lstrip('0')}~{slot[6:8]}시 {_title(k)}" for slot, k in keys.items()
    )


def _slot_changes(row):
    if row["slot_changes"] is None:
        return "—"
    if not row["slot_changes"]:
        return "그대로"
    return ", ".join(
        f"{c['slot'][:2].lstrip('0')}~{c['slot'][6:8]}시 {_title(c['from'])}→{_title(c['to'])}"
        for c in row["slot_changes"]
    )


def _change(cell):
    if cell["mean_diff"] is None:
        return "—"
    return f"{cell['mean_diff']:+.1f}초 [{cell['ci95_low']:+.1f}, {cell['ci95_high']:+.1f}] {VERDICT[cell['verdict']]}"


def render(data: dict, conditions: dict | None = None) -> str:
    plans = list(data["baseline"])
    rec, runner_up = data["baseline_recommendation"], data["baseline_runner_up"]
    lines = ["# 운영 시뮬레이션 민감도 보고서 (개발자용)", ""]
    if conditions:
        lines += ["조건: " + " · ".join(f"{k} {v}" for k, v in conditions.items()), ""]
    lines += [
        f"엔진 {data['engine']} · 반복 {data['repetitions']}회 · 시드 {data['random_seed']} · 방법 {data['method']}",
        "",
        "## 기준 결과",
        "",
        "| 운영안 | 주문 후 수령 평균 | 주문 후 수령 P90 | 목표 달성(30회 중) | 목표 충족 |",
        "|---|---|---|---|---|",
    ]
    for pid in plans:
        b = data["baseline"][pid]
        lines.append(
            f"| {_title(pid)} ({pid}) | {_sec(b['avg_post_order_receipt_sec'])} | {_sec(b['p90_post_order_receipt_sec'])} | "
            f"{_rate(b['quality_pass_rate'])} | {'예' if b['passes_quality_targets'] else '아니오'} |"
        )
    slot = data.get("baseline_slot_plan")
    lines += [""]
    if slot:
        lines += [
            f"시간대별 추천(기준): **{_slots(slot['slot_choice_keys'])}** · 목표 달성 {_rate(slot['quality_pass_rate'])} · "
            f"{slot['total_staff_hours']:g}인시",
            "",
        ]
    lines += [
        f"하루 단위 참고: 추천 {_title(rec)} · 2위 {_title(runner_up)}",
        "",
        "## 사장님께 보여 줄 제안",
        "",
    ]
    if data["user_suggestions"]:
        lines += [f"- {s['message']}" for s in data["user_suggestions"]]
    else:
        lines.append(f"- {data.get('user_stable_message') or '보여 줄 제안이 없어요.'}")
    lines += [
        "",
        "대상: 하루 주문량 ±20%, 제조시간 ±20%(숙련도). 시간대별 추천이 바뀌거나, 기준 조합이 바뀐 조건에서 목표를 못 지킬 때만 보여 줍니다.",
        "",
        "## 유의미한 변화",
        "",
    ]
    meaningful = [e for e in data["experiments"] if e["is_meaningful"]]
    if not meaningful:
        lines.append("- 추천이 바뀌거나 추천안이 목표를 놓친 조건이 없습니다.")
    for e in meaningful:
        why = []
        if e["meaning_basis"] == "slot":
            if e["slot_changes"]:
                why.append("시간대별 추천 " + _slot_changes(e))
            if e["base_slot_plan_now_fails"]:
                why.append(
                    f"기준 조합 목표 미달 (달성 {_rate(e['base_slot_plan_under_variant']['quality_pass_rate'])})"
                )
            lines.append(f"- **{_label(e)}**: " + ", ".join(why))
            continue
        if e["recommendation_changed"]:
            why.append(f"추천 {_title(rec)} → {_title(e['recommendation'])}")
        if e["recommended_plan_now_fails"]:
            why.append(
                f"{_title(rec)} 목표 미달 (달성 {_rate(e['plans'][rec]['quality_pass_rate'])})"
            )
        lines.append(f"- **{_label(e)}** (하루 단위 참고): " + ", ".join(why))
    lines += [
        "",
        "## 전체 결과",
        "",
        '시간대별 기준은 사장님 제안 대상 4개 조건에서만 다시 계산합니다(나머지는 "—").',
        "",
        "| 조건 | 시간대별 추천 변화 | 기준 조합 목표 달성 | 기준 조합 주문 후 수령 평균 변화 |",
        "|---|---|---|---|",
    ]
    for e in data["experiments"]:
        kept = e["base_slot_plan_under_variant"]
        lines.append(
            f"| {_label(e)} | {_slot_changes(e)} | {_rate(kept['quality_pass_rate']) if kept else '—'} | "
            f"{_change(kept['change_vs_baseline']['avg_post_order_receipt_sec']) if kept else '—'} |"
        )
    lines += [
        "",
        "하루 단위 세 안 비교 (개발자 참고).",
        "",
        "주문 후 수령 평균의 기준 대비 변화 (같은 반복끼리 짝지은 차이, 평균 [95% 구간]).",
        "",
        "| 조건 | 하루 추천 | 기준 하루 추천안 목표 | "
        + " | ".join(_title(p) for p in plans)
        + " | 기준 추천안−2위 P90 |",
        "|---|---|---|" + "---|" * len(plans) + "---|",
    ]
    for e in data["experiments"]:
        cells = [
            _change(e["plans"][p]["change_vs_baseline"]["avg_post_order_receipt_sec"])
            for p in plans
        ]
        status = (
            "—"
            if not rec
            else ("충족" if e["plans"][rec]["passes_quality_targets"] else "미달")
        )
        gap = e["recommended_vs_runner_up_p90"]
        lines.append(
            f"| {_label(e)} | {_title(e['recommendation'])}{' (바뀜)' if e['recommendation_changed'] else ''} | {status} | "
            + " | ".join(cells)
            + f" | {_change(gap) if gap else '—'} |"
        )
    lines += [
        "",
        "## 판정 기준",
        "",
        "- 시간대별 추천: 앞 구간부터 목표를 지키는 가장 싼 안을 고르고 이어 붙인 하루를 다시 검증한 결과. 기준 조합은 바뀐 조건에서 같은 조합을 다시 돌려 확인합니다.",
        "- 같은 반복 번호는 같은 시드라 손님 조건이 짝지어집니다. 차이 = 변경 조건 − 기준(하루 표 마지막 열은 기준 추천안 − 2위안).",
        '- 95% 구간(t분포)에 0이 들어가면 "차이 없음"(CMP-002). 음수는 빨라짐입니다.',
        "- 주문량 변경은 손님 도착 자체가 달라져 짝짓기 효과가 약합니다. 해석할 때 참고하세요.",
        f"- {data['notice']}",
        "",
    ]
    return "\n".join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description="운영 시뮬레이션 민감도 보고서")
    parser.add_argument("--daily-orders", type=int, default=150)
    parser.add_argument("--last-order", default="18:45")
    parser.add_argument("--repetitions", type=int, default=30)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--engine", choices=("simpy", "reference"), default="simpy")
    parser.add_argument("--out", default="sensitivity_report.md")
    parser.add_argument("--json", help="원자료 JSON도 저장할 경로")
    args = parser.parse_args(argv)
    body = {
        "scenario": {
            "daily_orders": args.daily_orders,
            "last_order_time": args.last_order,
        },
        "repetitions": args.repetitions,
        "random_seed": args.seed,
    }
    data = sensitivity(body, engine=args.engine)
    conditions = {
        "하루 주문량": f"{args.daily_orders}잔",
        "라스트 오더": args.last_order,
    }
    Path(args.out).write_text(render(data, conditions), encoding="utf-8")
    if args.json:
        Path(args.json).write_text(
            json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8"
        )
    print(f"보고서 저장: {args.out}")


if __name__ == "__main__":
    main()
