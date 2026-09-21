import { afterEach, describe, expect, it, vi } from "vitest";
import { SuperOpsRateLimitProbe, RATE_LIMIT_PROBE_TOOLS } from "./rate-limit-probe.js";
import { publishToolDefinition } from "./tool-catalogue.js";

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
  it("publishes every probe tool with read-only MCP safety annotations", () => {
    for (const tool of RATE_LIMIT_PROBE_TOOLS) {
      const published = publishToolDefinition(tool);
      expect(published.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      });
      expect(published.description).toContain("Read-only. Does not modify SuperOps data.");
    }
  });

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

  it("selects getTicketList when requested and records the task without storing ticket data", async () => {
    const harness = fakeState();
    const requests: Array<{ query?: string; variables?: unknown }> = [];
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { query?: string; variables?: unknown });
      return new Response(JSON.stringify({
        data: { getTicketList: { tickets: [{ ticketId: "private-ticket-id", displayId: "62609" }], listInfo: { page: 1 } } },
      }));
    });
    vi.stubGlobal("fetch", fetcher);

    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });
    const started = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start", task: "getTicketList" }),
    }));
    const startedBody = await started.json() as { runId: string; task: string };
    expect(startedBody.task).toBe("getTicketList");

    await probe.alarm();

    const statusResponse = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "status", runId: startedBody.runId }),
    }));
    const status = await statusResponse.json() as Record<string, unknown>;
    expect(status.task).toBe("getTicketList");
    expect(fetcher).toHaveBeenCalledTimes(10);
    expect(requests[0]?.query).toContain("getTicketList");
    expect(requests[0]?.query).not.toContain("getClientList");

    const resultsResponse = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "results", runId: startedBody.runId, limit: 20 }),
    }));
    const results = await resultsResponse.json() as { events: Array<Record<string, unknown>> };
    expect(results.events).toHaveLength(10);
    expect(results.events[0]).toMatchObject({ task: "getTicketList", outcome: "success" });
    expect(JSON.stringify(results)).not.toContain("private-ticket-id");
  });

  it("supports the one-minute 100-per-minute profile", async () => {
    const harness = fakeState();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { getTicketList: { tickets: [{ ticketId: "private-ticket-id", displayId: "62609" }], listInfo: { page: 1 } } },
    })));
    vi.stubGlobal("fetch", fetcher);

    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });
    const started = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start", task: "getTicketList", profile: "oneMinute100" }),
    }));
    const startedBody = await started.json() as { runId: string; profile: string; startedAt: string; deadlineAt: string };
    expect(startedBody.profile).toBe("oneMinute100");
    expect(Date.parse(startedBody.deadlineAt) - Date.parse(startedBody.startedAt)).toBe(60_000);

    await probe.alarm();

    expect(fetcher).toHaveBeenCalledTimes(16);
    const statusResponse = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "status", runId: startedBody.runId }),
    }));
    await expect(statusResponse.json()).resolves.toMatchObject({
      profile: "oneMinute100",
      currentPhase: "burst_100_per_minute",
      currentTargetRequestsPerMinute: 100,
    });
  });

  it("supports the one-minute staggered 100-per-minute profile", async () => {
    const harness = fakeState();
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      data: { getTicketList: { tickets: [{ ticketId: "private-ticket-id", displayId: "62609" }], listInfo: { page: 1 } } },
    })));
    vi.stubGlobal("fetch", fetcher);

    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });
    const started = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start", task: "getTicketList", profile: "oneMinute100Staggered" }),
    }));
    const startedBody = await started.json() as { runId: string; profile: string; requestIntervalMs: number };
    const firstAlarm = Number(harness.getAlarm());

    await probe.alarm();

    expect(startedBody.profile).toBe("oneMinute100Staggered");
    expect(startedBody.requestIntervalMs).toBe(600);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(Number(harness.getAlarm()) - firstAlarm).toBe(600);

    for (let attempt = 1; attempt < 100; attempt += 1) await probe.alarm();
    expect(fetcher).toHaveBeenCalledTimes(100);

    const statusResponse = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "status", runId: startedBody.runId }),
    }));
    await expect(statusResponse.json()).resolves.toMatchObject({
      profile: "oneMinute100Staggered",
      totalAttempts: 100,
      currentPhase: "staggered_100_per_minute",
      currentTargetRequestsPerMinute: 100,
    });
  });

  it("rejects an unsupported probe task", async () => {
    const harness = fakeState();
    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });

    const response = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start", task: "getAssetList" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "task must be getClientList, getTicketList, or getTicketListOpenQueue." });
  });

  it("supports the exact filtered open-ticket request", async () => {
    const harness = fakeState();
    const requests: Array<{ query?: string; variables?: unknown }> = [];
    const fetcher = vi.fn(async (_input: unknown, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as { query?: string; variables?: unknown });
      return new Response(JSON.stringify({
        data: { getTicketList: { tickets: [], listInfo: { totalCount: 0 } } },
      }));
    });
    vi.stubGlobal("fetch", fetcher);

    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });
    const started = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start", task: "getTicketListOpenQueue" }),
    }));
    const startedBody = await started.json() as { runId: string; task: string };
    await probe.alarm();

    expect(startedBody.task).toBe("getTicketListOpenQueue");
    expect(requests).toHaveLength(10);
    expect(requests[0]?.query).toContain("pageSize: 10000");
    expect(requests[0]?.query).toContain('attribute: "status"');
    expect(requests[0]?.query).toContain('"Waiting on third party"');
    expect(requests[0]?.query).toContain("updatedTime");
    expect(requests[0]?.query).toContain("createdTime");
    expect(requests[0]?.variables).toEqual({});
  });

  it("rejects an unsupported probe profile", async () => {
    const harness = fakeState();
    const probe = new SuperOpsRateLimitProbe(harness.state, {
      SUPEROPS_API_TOKEN: "secret-token-never-log",
      SUPEROPS_SUBDOMAIN: "computaskltd",
      SUPEROPS_RATE_LIMIT_PROBE_ENABLED: "true",
    });

    const response = await probe.fetch(new Request("https://probe.local/state", {
      method: "POST",
      body: JSON.stringify({ action: "start", profile: "burst" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "profile must be standard, oneMinute100, or oneMinute100Staggered." });
  });
});
