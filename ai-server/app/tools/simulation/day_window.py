"""영업시간(오픈~마감), 시간대 경계, 바쁜 시간.

두 가지 하루가 있다.
- 상권 데이터 하루(지금 버전, 기본): 오픈 06:00~10:30, 마감 17:30~21:00(30분 단위). 시간대는 네 칸
  (오픈~11, 11~14, 14~17, 17~마감)이고 비중은 상권 데이터 시간대(06~11·17~21시)에서 온다.
- 가게 데이터 하루: 시간대별 주문 수(orders_by_slot)를 가게가 넣으면 그 시간대 경계를 그대로 쓴다
  (예: 1시간 단위 08~09, 09~10, …). 오픈 05:00~, 마감 ~23:30, 30분 단위, 4시간 이상.
바쁜 시간(서로 돕기·한 명 추가가 바뀌는 구간)은 기본 11~14시이고, 시간대 경계 위에서 바꿀 수 있다.

엔진 안의 시각은 오픈부터 지난 초다. 계산 하나(compare·sensitivity)가 도는 동안 using()으로
그 하루를 정하고, 엔진 함수는 day()로 읽는다. 정하지 않으면 기본 07:00~19:00이다.
"""

from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

DEFAULT_OPEN = "07:00"
DEFAULT_CLOSE = "19:00"
OPEN_RANGE = ("06:00", "10:30")
CLOSE_RANGE = ("17:30", "21:00")
# 가게 데이터 하루의 범위.
STORE_OPEN_MIN = "05:00"
STORE_CLOSE_MAX = "23:30"
STORE_MIN_HOURS = 4
# 상권 데이터 하루의 안쪽 경계(바쁜 시간 11~14시, 14~17시).
INNER_EDGES = ("11:00", "14:00", "17:00")
DEFAULT_PEAK = ("11:00", "14:00")
STEP_MIN = 30


def to_sec(text: str) -> int:
    if not isinstance(text, str):
        raise ValueError("Time must be HH:MM")
    parts = text.split(":")
    try:
        hh, mm = map(int, parts)
    except Exception as exc:
        raise ValueError(f"Invalid HH:MM: {text}") from exc
    if len(parts) != 2 or not 0 <= hh <= 23 or not 0 <= mm < 60:
        raise ValueError(f"Invalid HH:MM: {text}")
    return hh * 3600 + mm * 60


def _hhmm(sec: int) -> str:
    return f"{sec // 3600:02d}:{sec % 3600 // 60:02d}"


@dataclass(frozen=True)
class Day:
    open: str
    close: str
    inner: tuple[str, ...] = INNER_EDGES
    peak: tuple[str, str] = DEFAULT_PEAK

    @property
    def open_abs(self) -> int:
        return to_sec(self.open)

    @property
    def length(self) -> int:
        return to_sec(self.close) - self.open_abs

    @property
    def edges(self) -> tuple[str, ...]:
        return (self.open, *self.inner, self.close)

    @property
    def slots(self) -> tuple[str, ...]:
        e = self.edges
        return tuple(f"{a}-{b}" for a, b in zip(e, e[1:]))

    @property
    def label(self) -> str:
        return f"{self.open}-{self.close}"

    @property
    def is_store(self) -> bool:
        """가게가 넣은 시간대 경계를 쓰는 하루."""
        return self.inner != INNER_EDGES

    def rel(self, text: str) -> int:
        """시각 → 오픈부터 지난 초."""
        return to_sec(text) - self.open_abs

    def clock(self, sec: float) -> str:
        total = int(sec) + self.open_abs
        return f"{total // 3600:02d}:{total % 3600 // 60:02d}"

    @property
    def is_default(self) -> bool:
        return (self.open, self.close) == (DEFAULT_OPEN, DEFAULT_CLOSE) and not self.is_store


def _step(sec: int, name: str):
    if sec % (STEP_MIN * 60):
        raise ValueError(f"{name} 시각은 {STEP_MIN}분 단위로 골라 주세요.")


def make(
    open_time: str | None = None,
    close_time: str | None = None,
    inner: tuple[str, ...] | list[str] | None = None,
    peak: tuple[str, str] | list[str] | None = None,
) -> Day:
    o = DEFAULT_OPEN if open_time is None else open_time
    c = DEFAULT_CLOSE if close_time is None else close_time
    o_sec, c_sec = to_sec(o), to_sec(c)
    _step(o_sec, "오픈")
    _step(c_sec, "마감")
    if inner is None or tuple(inner) == INNER_EDGES:
        inner_t = INNER_EDGES
        for sec, (lo, hi), name in ((o_sec, OPEN_RANGE, "오픈"), (c_sec, CLOSE_RANGE, "마감")):
            if not to_sec(lo) <= sec <= to_sec(hi):
                raise ValueError(f"{name} 시각은 {lo}~{hi} 사이로 골라 주세요.")
    else:
        if o_sec < to_sec(STORE_OPEN_MIN) or c_sec > to_sec(STORE_CLOSE_MAX):
            raise ValueError(
                f"영업시간은 {STORE_OPEN_MIN}~{STORE_CLOSE_MAX} 안이어야 해요."
            )
        if c_sec - o_sec < STORE_MIN_HOURS * 3600:
            raise ValueError(f"영업시간은 {STORE_MIN_HOURS}시간 이상이어야 해요.")
        secs = [to_sec(t) for t in inner]
        for s in secs:
            _step(s, "시간대 경계")
        if any(b <= a for a, b in zip([o_sec, *secs], [*secs, c_sec])):
            raise ValueError("시간대는 오픈부터 마감까지 빈틈없이 순서대로 이어져야 해요.")
        inner_t = tuple(_hhmm(s) for s in secs)
    p = tuple(DEFAULT_PEAK if peak is None else peak)
    if len(p) != 2:
        raise ValueError("바쁜 시간은 시작·끝 두 시각이에요.")
    edge_secs = [o_sec, *(to_sec(t) for t in inner_t), c_sec]
    ps, pe = to_sec(p[0]), to_sec(p[1])
    if not (o_sec <= ps < pe <= c_sec) or ps not in edge_secs or pe not in edge_secs:
        raise ValueError("바쁜 시간은 영업시간 안, 시간대 경계에 맞춰 골라 주세요.")
    return Day(_hhmm(o_sec), _hhmm(c_sec), inner_t, (_hhmm(ps), _hhmm(pe)))


def _labels_edges(labels) -> tuple[str, str, tuple[str, ...]]:
    """시간대 이름("08:00-09:00")들 → (오픈, 마감, 안쪽 경계). 이어지지 않으면 ValueError."""
    spans = []
    for label in labels:
        if not isinstance(label, str) or label.count("-") != 1:
            raise ValueError(f"시간대 이름은 HH:MM-HH:MM이에요: {label}")
        a, b = label.split("-")
        spans.append((to_sec(a), to_sec(b)))
    spans.sort()
    for (a, b), (c, _) in zip(spans, spans[1:]):
        if b != c:
            raise ValueError("시간대는 빈틈없이 이어져야 해요.")
    edges = [spans[0][0]] + [b for _, b in spans]
    return _hhmm(edges[0]), _hhmm(edges[-1]), tuple(_hhmm(s) for s in edges[1:-1])


def from_scenario(spec) -> Day:
    """scenario → 하루. 시간대별 주문(orders_by_slot)의 경계가 상권 네 칸과 다르면 가게 데이터 하루다."""
    spec = spec if isinstance(spec, dict) else {}
    peak = None
    if spec.get("peak_start_time") is not None or spec.get("peak_end_time") is not None:
        peak = (spec.get("peak_start_time"), spec.get("peak_end_time"))
    slots = spec.get("orders_by_slot")
    if isinstance(slots, dict) and slots:
        o, c, inner = _labels_edges(slots.keys())
        if spec.get("start_time") not in (None, o) or spec.get("end_time") not in (None, c):
            raise ValueError("start_time·end_time은 시간대별 주문의 처음·끝과 같아야 해요.")
        return make(o, c, inner, peak)
    return make(spec.get("start_time"), spec.get("end_time"), None, peak)


DEFAULT = make()
_current: ContextVar[Day] = ContextVar("operation_day", default=DEFAULT)


def day() -> Day:
    return _current.get()


@contextmanager
def using(value: Day):
    token = _current.set(value)
    try:
        yield value
    finally:
        _current.reset(token)
