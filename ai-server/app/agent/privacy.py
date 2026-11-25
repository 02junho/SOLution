"""AI 전달·응답에 포함되는 연락처와 명시된 사람 이름을 가린다. 원문은 기록하지 않는다."""

import re
from typing import Any

_PHONE = re.compile(r"(?<!\d)(?:01[016-9]|02|0[3-6][1-5])[-\s]?\d{3,4}[-\s]?\d{4}(?!\d)")
_EMAIL = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
_PERSON = re.compile(r"((?:담당자|성함|이름)\s*[:：=]?\s*)[가-힣]{2,4}")
_PRIVATE_FIELDS = {"phone", "phone_number", "email", "person_name", "contact_name", "customer_name",
                   "owner_name", "전화번호", "이메일", "담당자", "성함"}


def sanitize(value: Any) -> Any:
    if isinstance(value, str):
        return _PERSON.sub(r"\1[이름]", _EMAIL.sub("[이메일]", _PHONE.sub("[전화번호]", value)))
    if isinstance(value, dict):
        result = {}
        for key, item in value.items():
            masked_key = sanitize(key) if isinstance(key, str) else key
            safe_key = masked_key
            suffix = 2
            while safe_key in result:  # 서로 다른 민감한 키가 같은 마스킹 값이 되어도 항목을 보존한다.
                safe_key = f"{masked_key}_{suffix}"
                suffix += 1
            result[safe_key] = "[개인정보]" if str(key).lower() in _PRIVATE_FIELDS and item is not None else sanitize(item)
        return result
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    return value
