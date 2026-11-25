import hashlib
import json
import logging
import time

from pathlib import Path

from psycopg_pool import PoolTimeout

from app.core.db import get_pool
from app.rag.quote_search import embedding, EMBEDDING_MODEL


log = logging.getLogger("uvicorn.error")


# 현재 scripts 폴더의 경로
SCRIPT_DIR = Path(__file__).resolve().parent


# 자동 적재할 JSONL 파일
RAG_FILES = [
    SCRIPT_DIR / "quote-aliases-v2.jsonl",
    SCRIPT_DIR / "quote-aliases-extra-v2.jsonl"
]


SOURCE_TYPE = "item_alias"
SOURCE_REF = "quote-demo:items:v2"
SOURCE_VERSION = "2"


# JSONL 데이터 읽기
def load_rag_rows():

    rows = []

    for file_path in RAG_FILES:

        with file_path.open(
            mode="r",
            encoding="utf-8"
        ) as source:

            for line in source:

                if not line.strip():
                    continue

                row = json.loads(line)

                if row["document_type"] != SOURCE_TYPE:
                    raise ValueError("잘못된 데이터 유형")

                if str(row["dictionary_version"]) != SOURCE_VERSION:
                    raise ValueError("품목 사전 버전 불일치")

                if not row["item_id"] or not row["content"].strip():
                    raise ValueError("품목 ID 또는 내용 누락")

                rows.append(row)

    if not rows:
        raise ValueError("RAG 적재 데이터가 없습니다.")

    return rows


# 데이터 변경 감지를 위한 체크섬 생성
def calculate_checksum(rows):

    content = json.dumps(
        rows,
        ensure_ascii=False,
        sort_keys=True
    )

    return hashlib.sha256(
        content.encode("utf-8")
    ).hexdigest()


# PostgreSQL BIGINT 범위의 고유 ID 생성
def generate_chunk_id(chunk_no):

    value = (
        f"{SOURCE_TYPE}:"
        f"{SOURCE_REF}:"
        f"{SOURCE_VERSION}:"
        f"{EMBEDDING_MODEL}:"
        f"{chunk_no}"
    )

    digest = hashlib.sha256(
        value.encode("utf-8")
    ).digest()

    return (
        int.from_bytes(digest[:8], "big")
        & ((1 << 63) - 1)
    ) or 1


# Spring Boot의 Flyway 마이그레이션 완료 대기
def wait_for_rag_table():

    deadline = time.monotonic() + 120

    while time.monotonic() < deadline:

        try:

            with get_pool().connection(timeout=3) as conn:

                result = conn.execute(
                    """
                    SELECT to_regclass('public.rag_chunk')
                    """
                ).fetchone()

                if result[0] is not None:

                    log.info("RAG 테이블 확인 완료")

                    return

        except PoolTimeout:

            pass

        time.sleep(2)

    raise RuntimeError(
        "Flyway의 rag_chunk 테이블 생성 대기 시간 초과"
    )


# RAG 자동 적재
def initialize_quote_rag():

    # 1. Flyway 테이블 생성 대기
    wait_for_rag_table()

    # 2. 기존 JSONL 데이터 읽기
    rows = load_rag_rows()

    # 3. 원본 데이터 체크섬 생성
    checksum = calculate_checksum(rows)

    log.info(
        "견적 RAG 데이터 확인: %s건",
        len(rows)
    )

    # 4. PostgreSQL 연결
    with get_pool().connection(timeout=5) as conn:

        with conn.cursor() as cursor:

            # 5. 여러 서버의 동시 적재 방지
            cursor.execute(
                """
                SELECT pg_advisory_xact_lock(
                    hashtextextended(%s, 0)
                )
                """,
                (f"{SOURCE_TYPE}:{SOURCE_REF}",)
            )

            # 6. 적재된 데이터 확인
            cursor.execute(
                """
                SELECT
                    COUNT(*),

                    COUNT(*) FILTER (
                        WHERE metadata_json ->> 'checksum' = %s
                    )

                FROM rag_chunk

                WHERE source_type = %s
                  AND source_ref = %s
                  AND source_version = %s
                  AND embedding_model = %s
                  AND store_id IS NULL
                """,
                (
                    checksum,
                    SOURCE_TYPE,
                    SOURCE_REF,
                    SOURCE_VERSION,
                    EMBEDDING_MODEL
                )
            )

            existing_count, matched_count = cursor.fetchone()

            # 7. 데이터 변경이 없으면 적재 생략
            if existing_count == matched_count == len(rows):

                log.info(
                    "견적 RAG 데이터 이미 적재됨: %s건",
                    len(rows)
                )

                return

            # 8. 임베딩할 텍스트 목록 생성
            contents = [
                row["content"]
                for row in rows
            ]

            log.info("KURE-v1 임베딩 생성 시작")

            # 9. KURE-v1 모델을 이용한 벡터 생성
            vectors = embedding(contents)

            if len(vectors) != len(rows):

                raise ValueError("임베딩 개수 불일치")

            # 10. PostgreSQL 벡터 데이터 적재
            for index, (row, vector) in enumerate(
                zip(rows, vectors)
            ):

                if len(vector) != 1024:

                    raise ValueError("임베딩 차원 불일치")

                chunk_id = generate_chunk_id(index)

                metadata = {

                    "item_id": row["item_id"],

                    "dictionary_version":
                        row["dictionary_version"],

                    "original_source_ref":
                        row["source_ref"],

                    "checksum": checksum
                }

                cursor.execute(
                    """
                    INSERT INTO rag_chunk (
                        chunk_id,
                        store_id,
                        source_type,
                        source_ref,
                        source_version,
                        chunk_no,
                        content,
                        metadata_json,
                        embedding,
                        embedding_model
                    )

                    VALUES (
                        %s,
                        NULL,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s,
                        %s::jsonb,
                        %s::vector,
                        %s
                    )

                    ON CONFLICT ON CONSTRAINT uq_rag_chunk_source

                    DO UPDATE SET

                        content = EXCLUDED.content,

                        metadata_json = EXCLUDED.metadata_json,

                        embedding = EXCLUDED.embedding

                    WHERE rag_chunk.store_id IS NULL
                    """,
                    (
                        chunk_id,
                        SOURCE_TYPE,
                        SOURCE_REF,
                        SOURCE_VERSION,
                        index,
                        row["content"],
                        json.dumps(
                            metadata,
                            ensure_ascii=False
                        ),
                        json.dumps(vector),
                        EMBEDDING_MODEL
                    )
                )

                if cursor.rowcount != 1:
                    raise RuntimeError("RAG 데이터 적재 충돌")

            # 11. 해당 자동 적재 그룹의 불필요한 데이터 정리
            cursor.execute(
                """
                DELETE FROM rag_chunk

                WHERE source_type = %s
                  AND source_ref = %s
                  AND source_version = %s
                  AND embedding_model = %s
                  AND store_id IS NULL
                  AND chunk_no >= %s
                """,
                (
                    SOURCE_TYPE,
                    SOURCE_REF,
                    SOURCE_VERSION,
                    EMBEDDING_MODEL,
                    len(rows)
                )
            )

    # 12. 적재 완료
    log.info(
        "견적 RAG 데이터 자동 적재 완료: %s건",
        len(rows)
    )