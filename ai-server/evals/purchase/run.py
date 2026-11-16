"""구매 최적화 평가 실행기.

ai-server 폴더에서:
    python -m evals.purchase.run                    # 결과 표를 화면에 출력
    python -m evals.purchase.run --out evals/results  # purchase_eval.md · purchase_eval.json 저장

사례마다 도구를 한 번 실행하고(같은 프로세스, DB 기록 없음) 다음을 본다.
1. 기대 결과(손계산·블라인드 정답)와 같은지: 응답 상태, 안 1·안 2·기준선 총액, 기준선이 어긴 조건, infeasible 원인
2. 독립 전수 열거 정답과 같은지 (oracle 사례)
3. 돌려준 구매안을 다시 합산하면 숫자가 맞고 모든 조건을 지키는지
"""

from __future__ import annotations

import argparse
import json
import statistics
import time
from datetime import datetime, timezone
from pathlib import Path

from pydantic import ValidationError

from app.tools.purchase import service
from app.tools.purchase.optimizer import InputError
from app.tools.purchase.schemas import PurchaseRequest
from evals.purchase import oracle
from evals.purchase.cases import all_cases


def call_tool(request: dict) -> tuple[str, dict | None, str | None]:
    """(응답 상태, data, message). 요청 오류(400)는 status "error"."""
    try:
        res = service.run(PurchaseRequest.model_validate(request))
    except (ValidationError, InputError) as exc:
        return "error", None, str(exc).splitlines()[0]
    return res.status.value, res.data, res.message


def evaluate(case: dict) -> dict:
    req, expect = case["request"], case["expect"]
    started = time.perf_counter()
    status, data, message = call_tool(req)
    elapsed_ms = (time.perf_counter() - started) * 1000

    row = {"id": case["id"], "name": case["name"], "source": case["source"], "status": status,
           "message": message, "ms": round(elapsed_ms, 1), "problems": []}
    problems = row["problems"]

    choices = {c["choice_key"]: c for c in data["summary"]["choices"]} if status == "ok" else {}
    details = {c["choice_key"]: c for c in data["detail"]["choices"]} if status == "ok" else {}
    p1 = choices.get("purchase_1", {}).get("total_krw")
    p2c = choices.get("purchase_2", {})
    p2 = "same" if p2c.get("same_as") else ("unavailable" if p2c and not p2c.get("available") else p2c.get("total_krw"))
    base = data["summary"]["baseline"]["total_krw"] if status == "ok" else None
    base_viol = data["detail"]["baseline"]["constraint_violations"] if status == "ok" else None
    viol = [v["constraint"] for v in data["violations"]] if status == "infeasible" else None
    row.update(p1=p1, p2=p2, baseline=base, baseline_violations=base_viol, violations=viol)

    # 1. 기대 결과
    if "status" in expect and status != expect["status"]:
        problems.append(f"상태 {status} ≠ 기대 {expect['status']}")
    for key, got in (("p1", p1), ("p2", p2), ("baseline", base), ("violations", viol)):
        if key in expect and got != expect[key]:
            problems.append(f"{key} {got} ≠ 기대 {expect[key]}")
    if "baseline_violations" in expect and base_viol is not None and sorted(base_viol) != sorted(expect["baseline_violations"]):
        problems.append(f"기준선 위반 {base_viol} ≠ 기대 {expect['baseline_violations']}")

    # 2. 독립 전수 열거. 정답이 있는 입력이므로 error·needs_input이 나오면 그것부터 실패다.
    if expect.get("oracle") and status not in ("ok", "infeasible"):
        problems.append(f"전수 열거 사례인데 상태가 {status}입니다 ({message})")
    if expect.get("oracle") and status in ("ok", "infeasible"):
        o1 = oracle.best_total(req, req["max_delivery_count"])
        o2 = oracle.best_total(req, 1)
        row["oracle"] = {"p1": o1, "p2": o2}
        if (o1 is None) != (status == "infeasible") or (o1 is not None and o1 != p1):
            problems.append(f"안 1 {p1 if status == 'ok' else 'infeasible'} ≠ 전수 열거 {o1 if o1 is not None else 'infeasible'}")
        if status == "ok":
            p2_total = p1 if p2 == "same" else (None if p2 == "unavailable" else p2)
            if p2_total != o2:
                problems.append(f"안 2 {p2} ≠ 전수 열거 {o2 if o2 is not None else 'unavailable'}")
            if base != oracle.baseline_total(req):
                problems.append(f"기준선 {base} ≠ 다시 계산 {oracle.baseline_total(req)}")

    # 3. 돌려준 안 검산. ok면 안 1은 언제나 쓸 수 있어야 하고, 쓸 수 있고 다른 안과 같지 않은 안마다 상세가 꼭 하나 있어야 한다.
    if status == "ok" and not choices.get("purchase_1", {}).get("available"):
        problems.append("ok인데 안 1을 쓸 수 없다고 나옵니다")
    detail_keys = [c["choice_key"] for c in data["detail"]["choices"]] if status == "ok" else []
    need_detail = [k for k, c in choices.items() if c.get("available") and not c.get("same_as")]
    if sorted(detail_keys) != sorted(need_detail):
        problems.append(f"상세 구매안 {detail_keys} ≠ 요약에서 쓸 수 있는 안 {need_detail}")
    rechecked = 0
    for key in need_detail:
        if key in details:
            problems.extend(oracle.check_plan(req, choices[key], details[key]))
            rechecked += 1
    row["plans_rechecked"] = rechecked

    if status == "ok" and base is not None and not base_viol:
        row["saving_vs_baseline_krw"] = base - p1
        row["saving_pct"] = round((base - p1) / base * 100, 2) if base else None
    row["passed"] = not problems
    return row


def summarize(rows: list[dict]) -> dict:
    ok_rows = [r for r in rows if r["status"] == "ok"]
    savings = [r["saving_pct"] for r in ok_rows if r.get("saving_pct") is not None]
    times = [r["ms"] for r in rows]
    return {
        "cases": len(rows),
        "passed": sum(r["passed"] for r in rows),
        "oracle_checked": sum("oracle" in r for r in rows),
        "plans_rechecked": sum(r.get("plans_rechecked", 0) for r in rows),
        "baseline_valid": len(savings),
        "baseline_broken": sum(bool(r["baseline_violations"]) for r in ok_rows),
        "saving_pct_mean": round(statistics.mean(savings), 2) if savings else None,
        "saving_pct_max": max(savings) if savings else None,
        "ms_median": round(statistics.median(times), 1) if times else None,
        "ms_max": max(times) if times else None,
    }


def _fmt(value) -> str:
    if value is None:
        return "-"
    if isinstance(value, int):
        return f"{value:,}"
    if isinstance(value, list):
        return ", ".join(value) if value else "없음"
    return str(value)


def to_markdown(rows: list[dict], summary: dict, meta: dict) -> str:
    lines = [
        "# 구매 최적화 평가 결과",
        "",
        f"실행 {meta['run_at']} · 사례 {summary['cases']}개 · 통과 {summary['passed']}개",
        "",
        "| 항목 | 값 |",
        "| --- | --- |",
        f"| 통과 | {summary['passed']} / {summary['cases']} |",
        f"| 독립 전수 열거와 대조한 사례 | {summary['oracle_checked']} |",
        f"| 다시 합산해 조건을 확인한 구매안 | {summary['plans_rechecked']} |",
        f"| 기준선이 조건을 어긴 사례 | {summary['baseline_broken']} |",
        f"| 기준선이 유효한 사례의 안 1 절감률 (평균 / 최대) | {_fmt(summary['saving_pct_mean'])}% / {_fmt(summary['saving_pct_max'])}% |",
        f"| 한 번 실행 시간 (중앙값 / 최대) | {summary['ms_median']}ms / {summary['ms_max']}ms |",
        "",
        "절감률은 합성 사례에서 최적화와 기준선(단위단가순 담기)을 비교한 값이다. 실제 매장 절감률이 아니다.",
        "기준선이 조건을 어긴 사례는 절감률을 내지 않는다 (조건을 어기고 싼 것은 비교 대상이 아니다).",
        "",
        "| 사례 | 정답 출처 | 상태 | 안 1 | 안 2 | 기준선 | 기준선 위반 | 판정 |",
        "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ]
    for r in rows:
        status = r["status"] + (f" ({_fmt(r['violations'])})" if r["violations"] else "")
        lines.append(
            f"| {r['id']} {r['name']} | {r['source']} | {status} | {_fmt(r['p1'])} | {_fmt(r['p2'])} | "
            f"{_fmt(r['baseline'])} | {_fmt(r['baseline_violations'])} | {'통과' if r['passed'] else '실패'} |"
        )
    failed = [r for r in rows if not r["passed"]]
    if failed:
        lines += ["", "## 실패 내용", ""]
        for r in failed:
            lines.append(f"- {r['id']}: " + " / ".join(r["problems"]))
    return "\n".join(lines) + "\n"


def run_all() -> tuple[list[dict], dict, dict]:
    rows = [evaluate(c) for c in all_cases()]
    meta = {"run_at": datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d %H:%M")}
    return rows, summarize(rows), meta


def main() -> int:
    parser = argparse.ArgumentParser(description="구매 최적화 평가 실행기")
    parser.add_argument("--out", help="결과를 저장할 폴더 (purchase_eval.md · purchase_eval.json)")
    args = parser.parse_args()
    rows, summary, meta = run_all()
    md = to_markdown(rows, summary, meta)
    if args.out:
        out = Path(args.out)
        out.mkdir(parents=True, exist_ok=True)
        (out / "purchase_eval.md").write_text(md, encoding="utf-8")
        (out / "purchase_eval.json").write_text(
            json.dumps({"meta": meta, "summary": summary, "cases": rows}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(md)
    return 0 if summary["passed"] == summary["cases"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
