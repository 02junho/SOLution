"""DB 연결. FastAPI가 쓰는 테이블은 execution_log, rag_chunk 두 개뿐이다. 나머지 테이블은 읽기만 한다.

테이블은 Spring의 Flyway(backend/src/main/resources/db/migration)가 만든다. 여기서 CREATE TABLE 하지 않는다.
"""

from psycopg_pool import ConnectionPool

from app.core.config import get_settings

_pool: ConnectionPool | None = None


def open_pool() -> None:
    global _pool
    if _pool is None:
        # wait=False: DB가 아직 안 떠 있어도 서버는 뜨고, 연결은 필요할 때 다시 시도한다.
        _pool = ConnectionPool(get_settings().database_conninfo, min_size=1, max_size=5, open=False)
        _pool.open(wait=False)


def close_pool() -> None:
    global _pool
    if _pool is not None:
        _pool.close()
        _pool = None


def get_pool() -> ConnectionPool:
    if _pool is None:
        open_pool()
    return _pool


def check_database() -> str:
    """연결 확인용. 'ok' 또는 'unavailable'."""
    try:
        with get_pool().connection(timeout=2) as conn:
            conn.execute("SELECT 1")
        return "ok"
    except Exception:
        return "unavailable"
