import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleTriageEmergingIssueUpsert } from "./triage-emerging-issue.js";
import { runWithOperationStore, SuperOpsOperationLedger } from "./operation-store.js";

function observation(overrides: Record<string, unknown> = {}) {
  return {
    issueFingerprint: "issue-cross-client-001",
    summary: "Repeated endpoint service failure across clients",
    firstSeen: "2026-08-18T09:00:00.000Z",
    lastSeen: "2026-08-19T09:00:00.000Z",
    affectedClientCount: 2,
    affectedRequesterCount: 3,
    affectedTicketNumbers: ["60001", "60002"],
    representativeTicketNumbers: ["60001"],
    evidenceStrength: "strong",
    signalState: "active",
    currentRelatedTicketNumbers: ["60001", "60002"],
    ...overrides,
  };
}

function parsed(result: Awaited<ReturnType<typeof handleTriageEmergingIssueUpsert>>) {
  return JSON.parse(result.content[0].text) as {
    [key: string]: unknown;
    signal: {
      [key: string]: unknown;
      affectedTicketNumbers: string[];
      representativeTicketNumbers: string[];
      currentRelatedTicketNumbers: string[];
    };
  };
}

function durableNamespace() {
  const values = new Map<string, unknown>();
  const ledger = new SuperOpsOperationLedger({
    storage: {
      get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
      put: async (key: string | Record<string, unknown>, value?: unknown) => {
        if (typeof key === "string") values.set(key, value);
        else for (const [entryKey, entryValue] of Object.entries(key)) values.set(entryKey, entryValue);
      },
      delete: async (key: string) => values.delete(key),
      list: async <T = unknown>(options?: { prefix?: string }) => new Map(
        [...values.entries()].filter(([key]) => !options?.prefix || key.startsWith(options.prefix))
      ) as Map<string, T>,
      getAlarm: async () => null,
      setAlarm: async () => undefined,
    },
  });
  return {
    values,
    namespace: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => ledger.fetch(request) }),
    },
  };
}

describe("triage emerging issue signalling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-19T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("creates one bounded durable signal with accepted-stage and final verification metadata", async () => {
    const result = await handleTriageEmergingIssueUpsert(observation());
    const body = parsed(result);

    expect(result.isError).not.toBe(true);
    expect(body).toMatchObject({
      outcome: "created",
      acceptedStage: "SignalPersisted",
      continuationRequired: false,
      ambiguityReconciled: true,
      finalVerification: { performed: true, verified: true },
      notificationDestination: null,
      executionAuthorised: false,
    });
    expect(body.signal).toMatchObject({
      issueFingerprint: "issue-cross-client-001",
      affectedClientCount: 2,
      affectedTicketNumbers: ["60001", "60002"],
      signalState: "active",
    });
    expect(body.signal.summary).not.toContain("<");
  });

  it("returns unchanged for an identical replay and does not duplicate evidence", async () => {
    await handleTriageEmergingIssueUpsert(observation({ issueFingerprint: "issue-replay-002" }));
    const result = await handleTriageEmergingIssueUpsert(observation({
      issueFingerprint: "issue-replay-002",
      affectedTicketNumbers: ["60001", "60001"],
      representativeTicketNumbers: ["60001", "60001"],
      currentRelatedTicketNumbers: ["60001", "60001"],
    }));
    const body = parsed(result);

    expect(body.outcome).toBe("unchanged");
    expect(body.signal.affectedTicketNumbers).toEqual(["60001", "60002"]);
    expect(body.signal.representativeTicketNumbers).toEqual(["60001"]);
    expect(body.signal.currentRelatedTicketNumbers).toEqual(["60001", "60002"]);
  });

  it("updates the existing fingerprint when another client and ticket become related", async () => {
    await handleTriageEmergingIssueUpsert(observation({ issueFingerprint: "issue-expand-003" }));
    const result = await handleTriageEmergingIssueUpsert(observation({
      issueFingerprint: "issue-expand-003",
      affectedClientCount: 3,
      affectedRequesterCount: 4,
      affectedTicketNumbers: ["60002", "60003"],
      representativeTicketNumbers: ["60003"],
      currentRelatedTicketNumbers: ["60002", "60003"],
      lastSeen: "2026-08-19T10:00:00.000Z",
    }));
    const body = parsed(result);

    expect(body.outcome).toBe("updated");
    expect(body.signal).toMatchObject({ affectedClientCount: 3, affectedRequesterCount: 4 });
    expect(body.signal.affectedTicketNumbers).toEqual(["60001", "60002", "60003"]);
    expect(body.signal.currentRelatedTicketNumbers).toEqual(["60001", "60002", "60003"]);
  });

  it("rejects requester or single-client recurrence and overlarge evidence", async () => {
    const singleClient = await handleTriageEmergingIssueUpsert(observation({
      issueFingerprint: "issue-single-004",
      affectedClientCount: 1,
    }));
    expect(singleClient.isError).toBe(true);

    const tooManyTickets = await handleTriageEmergingIssueUpsert(observation({
      issueFingerprint: "issue-bounds-005",
      affectedTicketNumbers: Array.from({ length: 51 }, (_, index) => String(61000 + index)),
    }));
    expect(tooManyTickets.isError).toBe(true);
  });

  it("expires an active signal after the central quiet period without claiming the incident is fixed", async () => {
    await handleTriageEmergingIssueUpsert(observation({ issueFingerprint: "issue-expiry-006" }));

    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    const result = await handleTriageEmergingIssueUpsert(observation({ issueFingerprint: "issue-expiry-006" }));
    const body = parsed(result);

    expect(body.outcome).toBe("expired");
    expect(body.signal.signalState).toBe("expired");
    expect(body.expiryDoesNotDeclareTheUnderlyingIncidentFixed).toBe(true);
  });

  it("supports an explicit resolved transition without changing related tickets", async () => {
    await handleTriageEmergingIssueUpsert(observation({ issueFingerprint: "issue-resolved-007" }));
    const result = await handleTriageEmergingIssueUpsert(observation({
      issueFingerprint: "issue-resolved-007",
      signalState: "resolved",
      lastSeen: "2026-08-19T11:00:00.000Z",
    }));
    const body = parsed(result);

    expect(body.outcome).toBe("resolved");
    expect(body.signal.signalState).toBe("resolved");
    expect(body.signal.currentRelatedTicketNumbers).toEqual(["60001", "60002"]);
  });

  it("uses the existing owner-scoped Durable Object operation store for idempotent signal persistence", async () => {
    const durable = durableNamespace();
    const args = observation({ issueFingerprint: "issue-durable-008" });
    const first = await runWithOperationStore(
      { SUPEROPS_OPERATION_LEDGER: durable.namespace },
      () => handleTriageEmergingIssueUpsert(args)
    );
    const second = await runWithOperationStore(
      { SUPEROPS_OPERATION_LEDGER: durable.namespace },
      () => handleTriageEmergingIssueUpsert(args)
    );

    expect(parsed(first).outcome).toBe("created");
    expect(parsed(second).outcome).toBe("unchanged");
    expect([...durable.values.keys()].some((key) => key.startsWith("signal:"))).toBe(true);
  });
});
