import json
import logging
import os
from functools import lru_cache

from fastapi import HTTPException
from app.schemas.quote import Search

log = logging.getLogger(__name__)

@lru_cache(maxsize=1)
def encoder():
    from sentence_transformers import SentenceTransformer
    return SentenceTransformer("nlpai-lab/KURE-v1")


def embedding(value):
    return encoder().encode(value, normalize_embeddings=True).tolist()


def retrieve(req: Search):
    dsn = os.getenv("RAG_DSN")
    if not dsn:
        raise HTTPException(503, "RAG_DSN 설정이 필요합니다.")
    try:
        import psycopg
        from psycopg.rows import dict_row
        vector = json.dumps(embedding(req.query))
        with psycopg.connect(dsn, row_factory=dict_row, connect_timeout=4,
                             options="-c statement_timeout=5000") as conn:
            return conn.execute("""
            SELECT id, item_id, content, source_ref, 1 - (embedding <=> %s::vector) AS score
            FROM rag_chunk WHERE document_type = %s AND (store_id = %s OR store_id IS NULL)
            AND (%s <> 'item_alias' OR dictionary_version = %s::integer)
            ORDER BY embedding <=> %s::vector LIMIT 5
        """, (vector, req.document_type, req.store_id, req.document_type,
              req.dictionary_version, vector)).fetchall()
    except Exception as exc:
        log.warning("견적 검색 백엔드 실패: %s", type(exc).__name__)
        raise HTTPException(503, "현재 품목 또는 근거 검색을 이용할 수 없습니다.") from exc

def search(req: Search):
    if req.document_type == "item_alias" and req.dictionary_version is None:
        raise HTTPException(422, "품목 검색에는 사전 버전이 필요합니다.")
    cutoff = float(os.getenv("RAG_MIN_SCORE", "0.65"))
    hits = [row for row in retrieve(req) if row["score"] >= cutoff]
    return {"status": "found" if hits else "no_evidence", "hits": hits}
