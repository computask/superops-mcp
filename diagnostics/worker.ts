import { persistRows, rowsFromTail } from "../src/api-call-log-worker.js";

type AuditEnv = Omit<Cloudflare.Env, "AUDIT_ENABLED" | "RETENTION_DAYS"> & { AUDIT_ENABLED: string; RETENTION_DAYS: string };

export default {
  async tail(events, env) {
    if (env.AUDIT_ENABLED === "false") return;
    await persistRows(env.API_CALL_LOG, rowsFromTail(events));
  },
  async scheduled(_event, env) {
    const days = Math.max(1, Math.min(90, Number(env.RETENTION_DAYS) || 30));
    const cutoff = new Date(Date.now() - days * 86400_000).toISOString();
    // Only this diagnostic table is affected by indexed, bounded retention.
    await env.API_CALL_LOG.batch([
      env.API_CALL_LOG.prepare("DELETE FROM superops_api_calls WHERE call_id IN (SELECT call_id FROM superops_api_calls WHERE started_at < ? ORDER BY started_at LIMIT 10000)").bind(cutoff),
      env.API_CALL_LOG.prepare("DELETE FROM superops_api_calls WHERE call_id IN (SELECT call_id FROM superops_api_calls ORDER BY started_at DESC LIMIT 10000 OFFSET 250000)"),
    ]);
  },
} satisfies ExportedHandler<AuditEnv>;
