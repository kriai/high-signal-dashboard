-- High Signal D1 schema. Keep migrations additive during the cutover window.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config_json TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS sources_name_active
    ON sources (name COLLATE NOCASE)
    WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY,
    generated_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL,
    manifest_json TEXT NOT NULL,
    ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0, 1)),
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS publication_documents (
    publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    body_text TEXT NOT NULL,
    content_type TEXT NOT NULL,
    etag TEXT NOT NULL,
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    PRIMARY KEY (publication_id, key)
);

CREATE TABLE IF NOT EXISTS app_state (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO app_state (key, value, updated_at)
VALUES ('active_publication_id', NULL, '1970-01-01T00:00:00Z');

CREATE TABLE IF NOT EXISTS tool_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('discover', 'test')),
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'completed', 'failed')),
    result_json TEXT,
    error TEXT,
    requested_at TEXT NOT NULL,
    claimed_at TEXT,
    finished_at TEXT,
    expires_at TEXT NOT NULL,
    idempotency_key TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS tool_jobs_pending_request
    ON tool_jobs (idempotency_key)
    WHERE state IN ('queued', 'running');

CREATE INDEX IF NOT EXISTS tool_jobs_state_requested
    ON tool_jobs (state, requested_at);

CREATE TABLE IF NOT EXISTS run_log (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    article_count INTEGER,
    source_count INTEGER,
    failed_source_count INTEGER,
    rows_read INTEGER NOT NULL DEFAULT 0,
    rows_written INTEGER NOT NULL DEFAULT 0,
    error TEXT
);

CREATE INDEX IF NOT EXISTS run_log_started_at ON run_log (started_at);
