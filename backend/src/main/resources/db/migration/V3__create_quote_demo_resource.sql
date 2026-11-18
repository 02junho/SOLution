CREATE TABLE IF NOT EXISTS quote_demo_resource (
    store_id     TEXT    NOT NULL,
    resource_key TEXT    NOT NULL,
    version      INTEGER NOT NULL,
    payload      JSONB   NOT NULL,
    PRIMARY KEY (store_id, resource_key, version)
);