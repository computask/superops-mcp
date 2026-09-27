-- Content-free observations. Separate from the seven-day exact private captures.
CREATE TABLE IF NOT EXISTS triage_tool_timing (
  event_id TEXT PRIMARY KEY,
  call_id TEXT NOT NULL,
  trigger_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  producer TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  stage TEXT NOT NULL,
  invocation_id TEXT,
  ticket_numbers_json TEXT NOT NULL,
  ticket_numbers_truncated INTEGER NOT NULL,
  outcome TEXT,
  worker_outcome TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS triage_tool_timing_run_idx ON triage_tool_timing(trigger_id, attempt, observed_at);
CREATE INDEX IF NOT EXISTS triage_tool_timing_retention_idx ON triage_tool_timing(observed_at);
