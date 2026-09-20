import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperOpsRateLimitProbe } from "./rate-limit-probe.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fakeState() {
  const values = new Map<string, unknown>();
  let alarm: number | Date | undefined;
  return {
    state: {
      storage: {
        async get<T>(key: string) { return values.get(key) as T | undefined; },
        async put<T>(key: string, value: T) { values.set(key, value); },
        async delete(key: string) { return values.delete(key); },
        async list<T>(options?: { prefix?: string }) {
          return new Map(
            [...values.entries()]
              .filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
              .map(([key, value]) => [key, value as T])
          );
        },
        async setAlarm(value: number | Date) { alarm = value; },
        async deleteAlarm() { alarm = undefined; },
      },
    },
    getAlarm: () => alarm,
  };
}

describe("read-only rate-limit probe", () => {
  it("sends one upstream attempt per probe request and records the first 429 without retrying", async () => {
    const harness = fakeState();
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value: unknown) => logs.push(String(value)));
    let callCount = 0;
    const fetcher = vi.fn(async () => {
      callCount += 1;
      if (callCount === 10) return new Response(JSON.stringify({
        errors: [{ message: "rate limit exceeded", extensions: { retryAfter: 17 } }],
      }));
      return new Response(JSON.stringify({ data: { getClientList: { clients: [{ accountId: "private-client-id" }], listInfo: { page: 1 } } } }));
    });
    vi.stubGlobal("fetch", fetcher);

    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });
    const started = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start" }),
    }));
    const startedBody = await started.json() as { runId: string };
    await probe.alarm();

    const statusResponse = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "status", runId: startedBody.runId }),
    }));
    const status = await statusResponse.json() as Record<string, unknown>;
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(status.totalAttempts).toBe(10);
    expect(status.rateLimitedAttempts).toBe(1);
    expect(status.firstRateLimitedPhase).toBe("steady_60_per_minute");

    const resultsResponse = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "results", runId: startedBody.runId, limit: 20 }),
    }));
    const results = await resultsResponse.json() as { events: Array<Record<string, unknown>> };
    expect(results.events).toHaveLength(10);
    expect(results.events.at(-1)).toMatchObject({
      outcome: "rate_limited",
      httpStatus: 200,
      retryAfterSeconds: 17,
      rateLimited: true,
    });
    expect(logs.join("\n")).not.toMatch(/secret-token-never-log|private-client-id/);
  });
});
