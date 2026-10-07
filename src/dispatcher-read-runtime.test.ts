import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
const require = createRequire(import.meta.url);
const wranglerRequire = createRequire(require.resolve("wrangler/package.json"));
const {build} = wranglerRequire("esbuild");
const {Miniflare} = wranglerRequire("miniflare");

describe("read recovery in the real Worker runtime", () => {
  it("restores the saved read after complete runtime restart using one original receipt and no new submission", async () => {
    const start = Date.parse("2026-10-07T12:00:00.000Z"), id = "9714f5f6-e9c5-4e03-95b8-de82d37b7bac";
    const persistence = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-read-"));
    const bundle = await build({stdin: {resolveDir: process.cwd(), loader: "ts", contents: `
      import {DispatcherReadJournal, withDispatcherReadScope} from './src/dispatcher-read-journal.ts';
      import {runWithOperationStore, SuperOpsOperationLedger} from './src/operation-store.ts';
      import {SuperOpsClient} from './src/client.ts';
      import {runWithExecutionConfig, runWithExecutionContext} from './src/execution.ts';
      export {SuperOpsOperationLedger as ReadLedger};
      export default { async fetch(request, env) {
        const now=Number(new URL(request.url).searchParams.get('at')); Date.now=()=>now;
        return runWithExecutionConfig({SUPEROPS_EXECUTION_REQUEST_TIMEOUT_MS:'1000',SUPEROPS_EXECUTION_CALL_AUDIT_ENABLED:'false'},()=>
          runWithOperationStore({SUPEROPS_OPERATION_LEDGER:env.JOURNAL},()=>runWithExecutionContext('synthetic_worker_read',()=>
            withDispatcherReadScope({workflow:'synthetic-runtime-workflow',ownerHash:'12345678',automatic:true},async()=>{
              try {return Response.json({data:await new SuperOpsClient({apiToken:'unused',subdomain:'synthetic',dispatcher:{DISPATCHER_TOKEN:'synthetic'}}).query('query { __typename }')});}
              catch(error) {return Response.json({state:error.state,requestId:error.requestId,recovery:error.readRecovery,errorClass:error.name});}
            }))));
      }};
    `}, bundle: true, write: false, format: "esm", platform: "neutral", external: ["node:*", "cloudflare:workers"]});
    const calls: Array<{method: string; url: string; key: string; body: string}> = [];
    const config = {name: "synthetic-read-recovery-worker", modules: true, script: bundle.outputFiles[0].text,
      compatibilityDate: "2026-07-01", compatibilityFlags: ["nodejs_compat"],
      durableObjects: {JOURNAL: {className: "ReadLedger", useSQLite: true}}, durableObjectsPersist: persistence,
      outboundService: async (request: Request) => {
        calls.push({method: request.method, url: request.url, key: request.headers.get("Idempotency-Key") ?? "", body: request.method === "POST" ? await request.text() : ""});
        expect(request.url.startsWith("https://superops-api-dispatcher.taskgroup.co.uk/")).toBe(true);
        return request.method === "POST" ? Response.json({requestId: id, source: "superops-mcp", status: "retry_wait", httpStatus: 200, errorClassification: "RATE_LIMITED",
          nextRetryAt: new Date(start + 60_000).toISOString(), readRecovery: {startedAt: new Date(start).toISOString(), deadlineAt: new Date(start + 900_000).toISOString(), throttleCount: 1}},
          {status: 202, headers: {"X-Dispatcher-Request-Id": id, "Retry-After": "60"}}) : Response.json({requestId: id, source: "superops-mcp", status: "succeeded", httpStatus: 200, response: {data: {__typename: "Query"}}});
      }};
    let mf = new Miniflare(config);
    try {
      expect(await (await mf.dispatchFetch(`http://localhost/?at=${start}`)).json()).toMatchObject({requestId: id, recovery: {durable: true}});
      await mf.dispose();
      mf = new Miniflare(config);
      expect(await (await mf.dispatchFetch(`http://localhost/?at=${start + 1000}`)).json()).toMatchObject({requestId: id, state: "retry_wait"});
      expect(calls).toHaveLength(1);
      expect(await (await mf.dispatchFetch(`http://localhost/?at=${start + 60_001}`)).json()).toEqual({data: {__typename: "Query"}});
      expect(calls.map(c => c.method)).toEqual(["POST", "GET"]);
      expect(calls[1].url).toBe(`https://superops-api-dispatcher.taskgroup.co.uk/v1/requests/${id}`);
      expect(calls[1].key).toBe(calls[0].key);
    } finally {await mf.dispose();}
  }, 30_000);
});
