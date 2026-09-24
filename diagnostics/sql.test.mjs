import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { INSERT_API_CALL, rowsFromTail, INSERT_TRIAGE_INVOCATION, invocationRowsFromTail } from '../dist/api-call-log-worker.js';

function database() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../migrations/api-call-log/0001_api_attempts.sql', import.meta.url), 'utf8'));
  db.exec(readFileSync(new URL('../migrations/api-call-log/0002_dispatcher_correlation.sql', import.meta.url), 'utf8'));
  return db;
}
function record(n, overrides = {}) {
  return rowsFromTail([{ scriptName: 'superops-mcp', outcome: 'ok', logs: [{ message: [JSON.stringify({
    event: 'superops.api_attempt_finished', callId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    startedAt: '2026-09-18T10:00:59.990Z', completedAt: '2026-09-18T10:01:00.010Z', durationMs: 20,
    endpointHost: 'api.superops.ai', tenant: 'computaskltd', operationType: 'query', operationName: 'getTicket',
    attempt: 1, httpStatus: 200, ok: true, outcome: 'success', ticketId: '123456', ...overrides,
  })] }] }])[0];
}
function insert(db, row) { db.prepare(INSERT_API_CALL).run(...Object.values(row)); }

test('real SQLite stores each call once and counts failed retries in the dispatch minute', () => {
  const db = database();
  insert(db, record(1)); insert(db, record(1));
  insert(db, record(2, { attempt: 2, ok: false, outcome: 'rate_limited', rateLimited: true }));
  const summary = db.prepare('SELECT * FROM superops_api_calls_per_minute').get();
  assert.equal(summary.total_attempts, 2); assert.equal(summary.minute_utc, '2026-09-18T10:00:00Z');
  assert.equal(summary.succeeded, 1); assert.equal(summary.failed, 1);
  assert.equal(summary.immediate_retry_attempts, 1); assert.equal(summary.rate_limited, 1);
  db.close();
});
test('timeline resolves canonical ticket IDs without confusing tenants', () => {
  const db = database();
  insert(db, record(1)); insert(db, record(2, { ticketNumber: '62521' }));
  insert(db, record(3, { tenant: 'other', ticketNumber: '99999' }));
  assert.equal(db.prepare('SELECT resolved_ticket_number FROM superops_api_call_timeline WHERE call_id=?').get(record(1).call_id).resolved_ticket_number, '62521');
  db.close();
});
test('dispatcher submissions persist as transport attempts, not direct upstream calls', () => {
  const db = database();
  insert(db, record(4, { endpointHost: 'superops-api-dispatcher.taskgroup.co.uk' }));
  insert(db, record(5, { endpointHost: 'superops-api-dispatcher.taskgroup.co.uk',
    ok: false, outcome: 'network_error', errorClass: 'DispatcherPending' }));
  const rows = db.prepare('SELECT endpoint_host,endpoint_path,outcome,error_class FROM superops_api_calls ORDER BY call_id').all();
  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.endpoint_host, 'superops-api-dispatcher.taskgroup.co.uk');
    assert.equal(row.endpoint_path, '/graphql');
  }
  assert.equal(rows[1].error_class, 'DispatcherPending');
  db.close();
});
test('dispatcher receipt and local stop reason survive SQLite persistence without payloads', () => {
  const db = database();
  insert(db, record(7, { endpointHost: 'superops-api-dispatcher.taskgroup.co.uk',
    dispatcherRequestId: '00000000-0000-4000-8000-000000000007', dispatcherState: 'retry_wait',
    dispatcherErrorCode: 'pending', httpStatus: undefined, ok: false, outcome: 'network_error' }));
  const row = db.prepare('SELECT dispatcher_request_id,dispatcher_state,dispatcher_error_code,http_status FROM superops_api_calls').get();
  assert.equal(row.dispatcher_request_id, '00000000-0000-4000-8000-000000000007');
  assert.equal(row.dispatcher_state, 'retry_wait'); assert.equal(row.dispatcher_error_code, 'pending');
  assert.equal(row.http_status, null);
  db.close();
});
test('pre-upstream tool failure is independently persisted with no customer text',()=>{
  const db=database();
  const rows=invocationRowsFromTail([{scriptName:'superops-mcp',outcome:'ok',logs:[{message:[JSON.stringify({
    event:'mcp.triage_execution_finished',timestamp:'2026-09-24T08:00:00.000Z',
    invocationId:'synthetic-invocation',toolName:'superops_tickets_apply_triage_plan',success:false,
    durationMs:2,subrequestsUsed:0,dispatcherSubmissions:0,mutationSubmissions:0,
    failureCodes:[{stage:'mcp_tool',errorCode:'validation_failed',message:'private customer body',headers:{Authorization:'private'}}],
    errorSummary:'private note',
  })]}]}]);
  assert.equal(rows.length,1); assert(!JSON.stringify(rows).includes('private'));
  db.prepare(INSERT_TRIAGE_INVOCATION).run(...rows[0]);
  db.prepare(INSERT_TRIAGE_INVOCATION).run(...rows[0]);
  const result=db.prepare('SELECT * FROM triage_mcp_invocations').all();
  assert.equal(result.length,1);assert.equal(result[0].dispatcher_submissions,0);assert.equal(result[0].success,0);
  db.close();
});
test('bounded retention removes expired diagnostics and leaves recent attempts', () => {
  const db = database(); insert(db, record(1, { startedAt: '2026-08-01T10:00:00.000Z' })); insert(db, record(2));
  db.prepare('DELETE FROM superops_api_calls WHERE call_id IN (SELECT call_id FROM superops_api_calls WHERE started_at < ? ORDER BY started_at LIMIT 10000)').run('2026-08-19T00:00:00.000Z');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM superops_api_calls').get().n, 1);
  db.close();
});
