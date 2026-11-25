"""요일 하나 계산 결과 기억(추천 근무표). "이미 계산한 요일은 다시 안 하기".

같은 조건(그 요일 하루 근무표 조건 + 엔진 + 기준값)이면 결과가 같다(시드 고정). 그래서 사장님이 토요일만 고치면
토요일만 다시 계산하고 나머지 요일은 기억해 둔 결과를 쓴다.

- 메모리 안에만 둔다(서버를 다시 켜면 사라진다). 결과는 DB에 따로 저장되니 문제없다.
- 크기 상한: ROSTER_DAY_CACHE(.env, 기본 50개). 요일 하나가 메모리에서 약 0.2 MB라 50개면 10 MB 안팎.
  넘치면 가장 오래 안 쓴 것부터 지운다. 0이면 기억하지 않는다.
- 원본 조건(이름·파일)은 키에 남기지 않고 해시만 쓴다.
- FastAPI가 요청을 스레드로 나눠 처리하므로 잠금으로 보호한다.
- 계산 중인 요일 목록(claim/release): 미리 계산이 돌고 있는 요일을 진짜 계산이 다시 돌리지 않고 이어받게 한다.
  ai-server가 프로세스 하나(uvicorn 기본)로 떠 있어서 이 목록 하나로 충분하다.
"""

from __future__ import annotations

import copy
import hashlib
import json
import threading
from collections import OrderedDict
from concurrent.futures import Future

from .parallel import env_setting

DEFAULT_SIZE = 50
MAX_SIZE = 500

_lock = threading.Lock()
_items: OrderedDict[str, dict] = OrderedDict()
_running: dict[str, Future] = {}


def size() -> int:
    """.env(ROSTER_DAY_CACHE)에서 상한을 읽는다. 잘못된 값이면 기본값."""
    raw = env_setting("ROSTER_DAY_CACHE")
    try:
        value = int(raw) if raw not in (None, "") else DEFAULT_SIZE
    except ValueError:
        return DEFAULT_SIZE
    return min(max(value, 0), MAX_SIZE)


def key(*parts) -> str:
    """조건을 정렬된 JSON으로 만들어 해시한다(키 순서가 달라도 같은 조건이면 같은 키)."""
    text = json.dumps(parts, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def get(k: str) -> dict | None:
    with _lock:
        hit = _items.get(k)
        if hit is None:
            return None
        _items.move_to_end(k)
    # 꺼낸 쪽이 고쳐도 기억이 바뀌지 않게 복사해서 준다.
    return copy.deepcopy(hit)


def put(k: str, value: dict) -> None:
    limit = size()
    if limit <= 0:
        return
    stored = copy.deepcopy(value)
    with _lock:
        _items[k] = stored
        _items.move_to_end(k)
        while len(_items) > limit:
            _items.popitem(last=False)


def claim(k: str) -> tuple[bool, Future]:
    """이 요일을 내가 계산하겠다고 표시한다. 이미 누가 계산 중이면 (False, 그 계산)을 돌려준다."""
    with _lock:
        running = _running.get(k)
        if running is not None:
            return False, running
        future: Future = Future()
        _running[k] = future
        return True, future


def release(k: str, future: Future, value=None, error: BaseException | None = None) -> None:
    """계산이 끝났다(또는 실패했다)고 알리고 목록에서 뺀다. 기다리던 요청이 결과를 받는다."""
    with _lock:
        if _running.get(k) is future:
            del _running[k]
    if error is not None:
        future.set_exception(error)
    else:
        future.set_result(value)


def running() -> int:
    with _lock:
        return len(_running)


def clear() -> None:
    """기억과 계산 중 목록을 비운다(테스트용)."""
    with _lock:
        _items.clear()
        _running.clear()


def count() -> int:
    with _lock:
        return len(_items)
