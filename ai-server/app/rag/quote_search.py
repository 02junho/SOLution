import json
import logging

from functools import lru_cache

from fastapi import HTTPException
from psycopg.rows import dict_row

from app.core.config import get_settings
from app.core.db import get_pool
from app.schemas.quote import Search


log = logging.getLogger(__name__)

EMBEDDING_MODEL = "nlpai-lab/KURE-v1"


# KURE-v1 임베딩 모델 로딩
@lru_cache(maxsize=1)
def encoder():

    from sentence_transformers import SentenceTransformer

    return SentenceTransformer(EMBEDDING_MODEL)


# 텍스트 또는 텍스트 목록 임베딩
def embedding(value):

    return encoder().encode(
        value,
        normalize_embeddings=True
    ).tolist()


# Vector DB 유사도 검색
def retrieve(req: Search):

    try:

        vector = json.dumps(embedding(req.query))

        with get_pool().connection(timeout=5) as conn:

            with conn.cursor(row_factory=dict_row) as cursor:

                cursor.execute(
                    "SET LOCAL statement_timeout = '5s'"
                )

                cursor.execute(
                    """
                    SELECT
                        chunk_id AS id,

                        metadata_json ->> 'item_id' AS item_id,

                        content,

                        COALESCE(
                            metadata_json ->> 'original_source_ref',
                            source_ref
                        ) AS source_ref,

                        1 - (embedding <=> %s::vector) AS score

                    FROM rag_chunk

                    WHERE source_type = %s

                      AND (
                          store_id::text = %s
                          OR store_id IS NULL
                      )

                      AND embedding_model = %s

                      AND (
                          %s <> 'item_alias'
                          OR source_version = %s
                      )

                    ORDER BY embedding <=> %s::vector

                    LIMIT 5
                    """,
                    (
                        vector,
                        req.document_type,
                        req.store_id,
                        EMBEDDING_MODEL,
                        req.document_type,
                        str(req.dictionary_version),
                        vector
                    )
                )

                return cursor.fetchall()

    except Exception as exc:

        log.warning(
            "견적 검색 백엔드 실패: %s",
            type(exc).__name__
        )

        raise HTTPException(
            503,
            "현재 품목 또는 근거 검색을 이용할 수 없습니다."
        ) from exc


# 유사도 기준을 충족한 검색 결과 반환
def search(req: Search):

    if (
        req.document_type == "item_alias"
        and req.dictionary_version is None
    ):

        raise HTTPException(
            422,
            "품목 검색에는 사전 버전이 필요합니다."
        )

    cutoff = get_settings().rag_min_score

    hits = [
        row
        for row in retrieve(req)
        if row["score"] >= cutoff
    ]

    return {
        "status": "found" if hits else "no_evidence",
        "hits": hits
    }