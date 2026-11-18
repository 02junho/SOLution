from decimal import Decimal

from fastapi import HTTPException
from app.schemas.quote import Requirements

def requirements(req: Requirements):
    result = {}
    issues = []
    seen = set()
    for plan in req.sales_plan:
        if plan.menu_id in seen or (plan.takeaway_cups is not None and plan.takeaway_cups > plan.cups):
            raise HTTPException(422, "중복 메뉴 또는 포장 잔수 오류")
        seen.add(plan.menu_id)
        if not plan.cups:
            continue
        recipe = req.recipes.get(plan.menu_id)
        if not recipe:
            issues.append(dict(code="MISSING_RECIPE", menu_id=plan.menu_id))
            continue
        for line in recipe:
            count = plan.cups if line.scope == "all" else plan.takeaway_cups
            if count is None:
                issues.append(dict(code="MISSING_TAKEAWAY_CUPS", menu_id=plan.menu_id, item_id=line.item_id))
                continue
            if not count:
                continue
            row = result.setdefault(line.item_id, dict(item_id=line.item_id, unit=line.unit,
                                                     gross_need=Decimal(0), usage=[]))
            if row["unit"] != line.unit:
                raise HTTPException(422, f"재료표 기준 단위 불일치: {line.item_id}")
            amount = count * line.amount_per_cup
            row["gross_need"] += amount
            row["usage"].append(dict(menu_id=plan.menu_id, cups=count,
                                     amount_per_cup=line.amount_per_cup, amount=amount))
    return {"status": "needs_input" if issues else "ok", "items": list(result.values()), "issues": issues}
