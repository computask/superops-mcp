CREATE TABLE superops_api_calls (
  call_id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  duration_ms INTEGER,
  tenant TEXT,
  endpoint_host TEXT NOT NULL,
  endpoint_path TEXT NOT NULL,
  ticket_number TEXT,
  ticket_id TEXT,
  item_key TEXT,
  request_id TEXT,
  invocation_id TEXT,
  execution_trace_id TEXT,
  tool_name TEXT,
  call_index INTEGER,
  request_purpose TEXT,
  operation_type TEXT,
  operation_name TEXT,
  attempt INTEGER NOT NULL,
  http_status INTEGER,
  ok INTEGER,
  outcome TEXT NOT NULL,
  error_class TEXT,
  graphql_code TEXT,
  rate_limited INTEGER NOT NULL,
  retry_after_seconds REAL,
  worker_outcome TEXT,
  stored_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX api_calls_started ON superops_api_calls(started_at);
CREATE INDEX api_calls_ticket ON superops_api_calls(tenant,ticket_number,started_at);
CREATE INDEX api_calls_ticket_id ON superops_api_calls(tenant,ticket_id,started_at);
CREATE INDEX api_calls_invocation ON superops_api_calls(invocation_id,call_index);
CREATE VIEW superops_api_call_timeline AS
SELECT c.*, COALESCE(c.ticket_number, (
  SELECT t.ticket_number FROM superops_api_calls t
  WHERE t.tenant=c.tenant AND t.ticket_id=c.ticket_id AND t.ticket_number IS NOT NULL
  ORDER BY t.started_at DESC LIMIT 1
)) AS resolved_ticket_number
FROM superops_api_calls c;
CREATE VIEW superops_api_calls_per_minute AS
SELECT strftime('%Y-%m-%dT%H:%M:00Z',started_at) AS minute_utc, tenant, endpoint_host,
  COUNT(*) AS total_attempts,
  SUM(operation_type='query') AS read_attempts,
  SUM(operation_type='mutation') AS write_attempts,
  SUM(ok=1) AS succeeded,
  SUM(ok=0) AS failed,
  SUM(ok IS NULL) AS incomplete,
  SUM(rate_limited) AS rate_limited,
  SUM(attempt>1) AS immediate_retry_attempts
FROM superops_api_calls
GROUP BY minute_utc,tenant,endpoint_host;
