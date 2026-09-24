-- Saved copies of relay-enabled feeds. A Cron Trigger refreshes them and the
-- relay serves them, because Substack refuses a Worker fetch made on behalf of
-- a GitHub Actions request but answers the same Worker on its own schedule.
-- One row per endpoint, replaced in place; body_text stays under D1's
-- 2,000,000-byte row limit.
CREATE TABLE IF NOT EXISTS relay_copies (
    url TEXT PRIMARY KEY,
    status INTEGER NOT NULL,
    content_type TEXT NOT NULL,
    final_url TEXT NOT NULL,
    retry_after TEXT,
    body_text TEXT NOT NULL,
    fetched_at TEXT NOT NULL
);
