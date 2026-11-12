import pytest

import app.tools.purchase.router as purchase_router


@pytest.fixture(autouse=True)
def tool_logs(monkeypatch):
    """테스트에서는 DB에 실행 기록을 쓰지 않고 모아 둔다."""
    logs: list[dict] = []
    monkeypatch.setattr(purchase_router, "write_tool_log", lambda **kwargs: logs.append(kwargs))
    return logs
