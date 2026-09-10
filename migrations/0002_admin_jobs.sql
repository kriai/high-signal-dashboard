CREATE INDEX IF NOT EXISTS tool_jobs_requested_at
    ON tool_jobs (requested_at);

CREATE INDEX IF NOT EXISTS tool_jobs_expires_at
    ON tool_jobs (expires_at);
