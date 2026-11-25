from typing import Annotated
from uuid import uuid4

from fastapi import Header

REQUEST_KEY_HEADER = "X-Request-Key"


def get_request_key(x_request_key: Annotated[str | None, Header()] = None) -> str:
    """Spring이 보낸 요청 키. execution_log.request_key에 쓴다. 직접 호출해서 없으면 새로 만든다.

    사용 예:
        @router.post("/tools/labor")
        def labor(body: LaborRequest, request_key: str = Depends(get_request_key)): ...
    """
    return x_request_key or str(uuid4())
