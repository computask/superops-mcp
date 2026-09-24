-- Additive only: preserve historical rows and existing retention.
ALTER TABLE superops_api_calls ADD COLUMN dispatcher_request_id TEXT;
ALTER TABLE superops_api_calls ADD COLUMN dispatcher_state TEXT;
ALTER TABLE superops_api_calls ADD COLUMN dispatcher_error_code TEXT;
CREATE INDEX api_calls_dispatcher_receipt ON superops_api_calls(dispatcher_request_id);

CREATE TABLE triage_mcp_invocations (
  invocation_id TEXT PRIMARY KEY,
  completed_at TEXT NOT NULL,
  execution_trace_id TEXT,
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER,
  subrequests_used INTEGER,
  dispatcher_submissions INTEGER,
  mutation_submissions INTEGER,
  failure_codes_json TEXT NOT NULL
);
CREATE INDEX triage_invocations_completed ON triage_mcp_invocations(completed_at);
