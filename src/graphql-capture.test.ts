import { afterEach, describe, expect, it, vi } from "vitest";
import { capturedDispatcherFetch, GRAPHQL_CAPTURE_BODY_BYTES, redactGraphqlText, runWithGraphqlCapture, type GraphqlCapture } from "./graphql-capture.js";
import { dispatcherFetch, DispatcherPendingError } from "./dispatcher.js";
import { runWithExecutionContext } from "./execution.js";
import { GraphqlCaptureStore, GRAPHQL_CAPTURE_RETENTION_MS, GRAPHQL_CAPTURE_DAY_BYTES } from "./graphql-capture-store.js";

const url = "https://superops-api-dispatcher.taskgroup.co.uk/graphql";
const secret = "synthetic-secret-not-a-real-key";
const body = JSON.stringify({query: "query Ticket($id: ID!) { getTicket(id: $id) { ticketId subject } }", variables: {id: "ticket-example"}});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

async function capture(fn: () => Promise<unknown>, sink?: (value: GraphqlCapture) => Promise<void>) {
  const records: GraphqlCapture[] = [];
  const run = () => runWithGraphqlCapture({secrets: [secret], persist: sink ?? (async value => { records.push(value); })}, fn);
  return {records, run};
}
function memory() {
  const values = new Map<string, unknown>();
  let alarm: number | null = null;
  return {values, storage: {
    get: async <T>(key: string) => values.get(key) as T | undefined,
    put: async <T>(key: string, value: T) => { values.set(key, structuredClone(value)); },
    delete: async (key: string) => values.delete(key),
    list: async <T>(options: {prefix: string}) => new Map([...values].filter(([key]) => key.startsWith(options.prefix))) as Map<string, T>,
    getAlarm: async () => alarm,
    setAlarm: async (time: number | Date) => { alarm = Number(time); },
  }};
}
function record(): GraphqlCapture {
  return {captureId: crypto.randomUUID(), version: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), complete: true, omittedExchanges: 0, exchanges: []};
}
const put = (value: GraphqlCapture) => new Request("https://store/graphql-captures", {method: "POST", body: JSON.stringify(value)});

describe("private GraphQL capture", () => {
  it("preserves full query/variables and all GraphQL errors without exposing credentials to normal logs", async () => {
    const raw = JSON.stringify({data: null, errors: [{message: "Synthetic field rejected", path: ["updateTicket"], extensions: {code: "INVALID_FIELD", details: {field: "status"}}}, {message: "second error"}]});
    const fetch = vi.fn(async () => new Response(raw, {status: 200, headers: {"set-cookie": secret, "x-dispatcher-request-id": "receipt-1"}}));
    vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const harness = await capture(() => runWithExecutionContext("superops_test", async () => {
      const response = await capturedDispatcherFetch(url, {method: "POST", body, headers: {Authorization: `Bearer ${secret}`, "CF-Access-Client-Secret": secret}});
      expect(await response.text()).toBe(raw);
    }));
    await harness.run();
    const exchange = harness.records[0].exchanges[0];
    expect(exchange.request.body?.text).toBe(body);
    expect(exchange.response?.body.text).toBe(raw);
    expect(exchange.response?.headers["set-cookie"]).toBe("[REDACTED]");
    expect(exchange.invocationId).toBeTruthy();
    expect(exchange.toolName).toBe("superops_test");
    expect(JSON.stringify(harness.records)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain("Synthetic field rejected");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("redacts nested credential values, echoed secrets, JWTs, malformed bodies and embedded GraphQL secrets", () => {
    const values = [
      JSON.stringify({data: {apiKey: "never-store-this", nested: [{access_token: "never-store-this"}], message: `echo ${secret}`}}),
      '{"apiKey":"never-store-this", broken',
      'mutation { task(password: "never-store-this") { id } }',
      JSON.stringify({query: 'mutation { task(password: "never-store-this") { id } }'}),
      "Authorization: Bearer never-store-this", "eyJabc.eyJdef.signature", "-----BEGIN PRIVATE KEY-----\nnever-store-this\n-----END PRIVATE KEY-----",
    ];
    for (const value of values) {
      const safe = redactGraphqlText(value, [secret]);
      expect(safe).not.toContain("never-store-this");
      expect(safe).not.toContain(secret);
      expect(safe).not.toContain("eyJabc");
    }
  });

  it("captures one POST and its uncertain receipt poll, preserving no-replay semantics", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(Response.json({requestId: "receipt-2", status: "queued"}, {status: 202, headers: {"Retry-After": "0"}}))
      .mockResolvedValueOnce(Response.json({requestId: "receipt-2", source: "superops-mcp", status: "uncertain", httpStatus: 200, errorClassification: "GRAPHQL_ERROR"}));
    vi.stubGlobal("fetch", fetch);
    const harness = await capture(() => dispatcherFetch(body, {env: {DISPATCHER_TOKEN: secret}, mutation: true, idempotencyKey: "same-key"}));
    await expect(harness.run()).rejects.toBeInstanceOf(DispatcherPendingError);
    expect(harness.records[0].exchanges.map(exchange => exchange.request.method)).toEqual(["POST", "GET"]);
    expect(harness.records[0].exchanges[1].response?.body.text).toContain("GRAPHQL_ERROR");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("preserves network failures and the same original error even if storage fails", async () => {
    const error = new Error(`network failed with ${secret}`);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(error));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const harness = await capture(() => capturedDispatcherFetch(url, {method: "POST", body}));
    await expect(harness.run()).rejects.toBe(error);
    expect(harness.records[0].exchanges[0].transportError).toContain("[REDACTED]");
    const failed = await capture(() => capturedDispatcherFetch(url, {}), async () => { throw new Error("storage unavailable"); });
    await expect(failed.run()).rejects.toBe(error);
  });

  it("does not consume the real response or fail the call when the capture body is oversized", async () => {
    const raw = "x".repeat(GRAPHQL_CAPTURE_BODY_BYTES + 1);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(raw, {status: 429, headers: {"Retry-After": "60"}})));
    const harness = await capture(async () => {
      const response = await capturedDispatcherFetch(url, {method: "POST", body});
      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("60");
      expect((await response.text()).length).toBe(raw.length);
    });
    await harness.run();
    expect(harness.records[0].complete).toBe(false);
    expect(harness.records[0].exchanges[0].response?.body).toMatchObject({complete: false, reason: "capture_size_limit"});
    expect(harness.records[0].exchanges[0].response?.body.text).toBeUndefined();
  });

  it("limits a stalled capture reader and returns the real response immediately", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({start() { /* Never sends body bytes. */ }}))));
    const pending: Promise<void>[] = [];
    const records: GraphqlCapture[] = [];
    const result = await runWithGraphqlCapture({secrets: [], waitUntil: work => pending.push(work), persist: async value => { records.push(value); }},
      () => capturedDispatcherFetch(url, {}));
    expect(result.status).toBe(200);
    await vi.advanceTimersByTimeAsync(5001);
    await Promise.all(pending);
    expect(records[0].exchanges[0].response?.body.reason).toBe("capture_body_timeout");
    void result.body?.cancel();
  });

  it("isolates concurrent requests and disabled calls", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({data: {ok: true}})));
    const first = await capture(async () => { await (await capturedDispatcherFetch(url, {method: "POST", body: "first"})).text(); });
    const second = await capture(async () => { await (await capturedDispatcherFetch(url, {method: "POST", body: "second"})).text(); });
    await Promise.all([first.run(), second.run()]);
    expect(first.records[0].exchanges[0].request.body?.text).toBe("first");
    expect(second.records[0].exchanges[0].request.body?.text).toBe("second");
    const log = vi.spyOn(console, "info");
    await (await capturedDispatcherFetch(url, {})).text();
    expect(log).not.toHaveBeenCalled();
  });

  it("keeps successful calls successful if persistence fails and bounds the exchange count", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({data: {ok: true}})));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failed = await capture(async () => (await capturedDispatcherFetch(url, {})).json(), async () => { throw new Error("capture_store_http_507"); });
    await expect(failed.run()).resolves.toEqual({data: {ok: true}});
    expect(JSON.stringify(errors.mock.calls)).toContain("capture_store_http_507");
    const bounded = await capture(async () => {
      for (let i = 0; i < 129; i++) await (await capturedDispatcherFetch(url, {})).text();
    });
    await bounded.run();
    expect(bounded.records[0]).toMatchObject({complete: false, omittedExchanges: 1});
    expect(bounded.records[0].exchanges).toHaveLength(128);
  });
});

describe("bounded private GraphQL store", () => {
  it("survives restart, lists metadata only, deduplicates writes and expires at exactly seven days", async () => {
    vi.useFakeTimers();
    const mem = memory();
    let store = new GraphqlCaptureStore(mem.storage);
    const entry = record();
    expect((await store.fetch(put(entry))).status).toBe(201);
    expect((await store.fetch(put(entry))).status).toBe(200);
    store = new GraphqlCaptureStore(mem.storage);
    const index = await (await store.fetch(new Request("https://store/graphql-captures"))).json() as {records: Record<string, unknown>[]};
    expect(index).toMatchObject({totalCount: 1});
    expect(index.records[0]).not.toHaveProperty("exchanges");
    const get = () => store.fetch(new Request(`https://store/graphql-captures?captureId=${entry.captureId}`));
    expect(await (await get()).json()).toEqual(entry);
    vi.setSystemTime(Date.parse(entry.startedAt) + GRAPHQL_CAPTURE_RETENTION_MS);
    expect((await get()).status).toBe(404);
    expect(mem.values.size).toBe(0);
  });

  it("caps daily storage, rejects partial/missing chunks and prunes by alarm", async () => {
    const mem = memory();
    const store = new GraphqlCaptureStore(mem.storage);
    const entry = record();
    await store.fetch(put(entry));
    mem.values.delete(`graphql-capture:body:${entry.captureId}:0`);
    const get = new Request(`https://store/graphql-captures?captureId=${entry.captureId}`);
    expect((await store.fetch(get)).status).toBe(409);
    const key = `graphql-capture:meta:${entry.captureId}`;
    const meta = mem.values.get(key) as Record<string, unknown>;
    mem.values.set(key, {...meta, bytes: GRAPHQL_CAPTURE_DAY_BYTES});
    expect((await store.fetch(put(record()))).status).toBe(507);
    await store.prune(Date.parse(entry.startedAt) + GRAPHQL_CAPTURE_RETENTION_MS);
    expect(mem.values.size).toBe(0);
  });

  it("does not change alarms or delete unrelated operation metadata", async () => {
    const mem = memory();
    mem.values.set("op:unrelated", {expiresAt: "2020-01-01"});
    // Some memory adapters return all keys: still enforce this store's prefix.
    const store = new GraphqlCaptureStore({...mem.storage, list: async <T>() => mem.values as Map<string, T>});
    expect(await store.prune()).toBeUndefined();
    expect(mem.values.has("op:unrelated")).toBe(true);
  });
});
