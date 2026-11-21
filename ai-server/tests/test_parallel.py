"""요일 동시 계산 수: .env(ROSTER_MAX_PROCESSES)로 정하고, 코어·요일 수를 넘지 않는다."""

from app.tools.simulation import parallel


def test_설정값과_코어_요일_수_중_가장_작은_값(monkeypatch):
    monkeypatch.setattr(parallel.os, "cpu_count", lambda: 8)
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "4")
    assert parallel.worker_count(7) == 4
    assert parallel.worker_count(3) == 3
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "1")
    assert parallel.worker_count(7) == 1
    monkeypatch.setattr(parallel.os, "cpu_count", lambda: 2)
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "7")
    assert parallel.worker_count(7) == 2


def test_비었거나_이상한_값은_기본값_범위는_1에서_7(monkeypatch):
    monkeypatch.setattr(parallel, "_from_env_file", lambda: None)
    monkeypatch.delenv("ROSTER_MAX_PROCESSES", raising=False)
    assert parallel.max_processes() == parallel.DEFAULT_MAX_PROCESSES
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "많이")
    assert parallel.max_processes() == parallel.DEFAULT_MAX_PROCESSES
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "0")
    assert parallel.max_processes() == 1
    monkeypatch.setenv("ROSTER_MAX_PROCESSES", "99")
    assert parallel.max_processes() == 7
