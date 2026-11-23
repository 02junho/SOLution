"""요일 동시 계산 수(추천 근무표·일주일 근무표). 운영 2번 확장.

배포 서버 크기에 맞춰 .env의 ROSTER_MAX_PROCESSES로 정한다(코드 수정 없이). 계산 프로세스 하나가 약 65 MB를 쓰고
계산하는 1분 동안 CPU를 꽉 쓴다. 작은 서버(예: 1~2 vCPU, 1~2 GB)는 1~2로 두고, 코어가 넉넉하면 7(요일 수)까지.
1이면 일반 계산은 프로세스를 따로 띄우지 않고 요청을 받은 프로세스 안에서 차례로 계산한다.
미리 계산(background)은 1이어도 낮은 우선순위의 계산 프로세스 하나를 따로 띄운다(약 65 MB 더).
"""

from __future__ import annotations

import os

DEFAULT_MAX_PROCESSES = 2
LIMIT = 7  # 요일 수보다 많이 띄울 일은 없다


def _from_env_file(name: str) -> str | None:
    """docker compose는 .env를 환경 변수로 넣어 주지만, 로컬에서 바로 띄우면 파일에서 읽는다."""
    try:
        from dotenv import dotenv_values

        from app.core.config import REPO_ROOT_ENV
    except ImportError:
        return None
    return dotenv_values(REPO_ROOT_ENV).get(name)


def env_setting(name: str) -> str | None:
    """설정 하나 읽기(환경 변수 먼저, 없으면 .env 파일). 요일 동시 계산 수와 요일 기억 크기가 같이 쓴다."""
    return os.environ.get(name) or _from_env_file(name)


def max_processes() -> int:
    raw = env_setting("ROSTER_MAX_PROCESSES")
    try:
        value = int(raw) if raw not in (None, "") else DEFAULT_MAX_PROCESSES
    except ValueError:
        value = DEFAULT_MAX_PROCESSES
    return max(1, min(LIMIT, value))


def worker_count(jobs: int) -> int:
    """요일 수, CPU 코어 수, 설정값 중 가장 작은 값."""
    return max(1, min(jobs, os.cpu_count() or 1, max_processes()))
