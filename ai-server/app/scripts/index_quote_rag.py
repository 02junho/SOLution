"""JSONL 소스 파일을 개발용 검색 DB에 적재. 실행할 때마다 행을 추가한다."""
import json
import os
import sys

import psycopg
from app.rag.quote_search import embedding

with open(sys.argv[1], encoding="utf-8") as source, psycopg.connect(os.environ["RAG_DSN"]) as db:
    for line in source:
        if not line.strip():
            continue
        row = json.loads(line)
        db.execute("""
            INSERT INTO rag_chunk(store_id, document_type, dictionary_version, item_id,
                                  content, source_ref, embedding)
            VALUES (%s,%s,%s,%s,%s,%s,%s::vector)
        """, (row.get("store_id"), row["document_type"], row.get("dictionary_version"),
              row.get("item_id"), row["content"], row["source_ref"], json.dumps(embedding(row["content"]))))
