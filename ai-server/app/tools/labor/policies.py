"""계산 정책. 미확정 보험 요율을 임의의 합산 요율로 대체하지 않는다."""

from decimal import Decimal

MINIMUM_WAGES = {2026: Decimal("10320"), 2027: Decimal("10700")}
BREAK_POLICY_VERSIONS = {"labor.kr.2026.v1", "labor.kr.2027.v1"}
INSURANCE_COMPONENTS = ("pension", "health", "long_term_care", "employment", "industrial_accident")

# 업종·연도별 공식 출처 검토 후 담당자가 등록한다. 요청 본문의 요율을 신뢰하지 않는다.
# 구조: {"policy_version": {"year": 2026, "source_ref": "공식 출처 URL", "rates": {...}}}
# rates는 기본급 대비 사업주 부담률. 장기요양은 건강보험료 대비 비율을 그대로 넣으면 안 된다.
APPROVED_INSURANCE_POLICIES: dict[str, dict] = {}

WAGE_SOURCES = {
    2026: "https://www.moel.go.kr/news/enews/report/enewsView.do?news_seq=18144",
    2027: "https://www.minimumwage.go.kr/minWage/policy/decisionMain.do",
}


def required_break_seconds(actual_work_seconds: int) -> int:
    if actual_work_seconds >= 8 * 3600:
        return 3600
    if actual_work_seconds >= 4 * 3600:
        return 1800
    return 0
