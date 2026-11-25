from enum import Enum


class ResponseStatus(str, Enum):
    """모든 API 공통 응답 상태. 기능별 세부 상태는 응답 data 안에 넣는다."""

    OK = "ok"  # 정상
    NEEDS_INPUT = "needs_input"  # 정보 부족, 사장님에게 질문 필요
    INFEASIBLE = "infeasible"  # 조건을 만족하는 답이 없음
    ERROR = "error"  # 시스템 오류
