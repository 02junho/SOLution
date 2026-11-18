CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS rag_chunk (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id text,
  document_type text NOT NULL CHECK (document_type IN ('item_alias','labor_rule','assumption','data_source')),
  dictionary_version integer,
  item_id text,
  content text NOT NULL,
  source_ref text NOT NULL,
  embedding vector(1024) NOT NULL,
  CHECK (document_type <> 'item_alias' OR (store_id IS NOT NULL AND item_id IS NOT NULL AND dictionary_version > 0 AND dictionary_version IS NOT NULL))
);
