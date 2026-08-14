import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadInitialScriptCatalogue } from "./script-catalogue-seed.js";
import {
  getScriptCatalogueStore,
  resetMemoryScriptCatalogueForTests,
} from "./script-catalogue-store.js";
import { syncScriptCatalogue } from "./script-catalogue-sync.js";
import { listSavedScriptMetadataPage } from "./domains/scripts.js";
import { getScriptCatalogueTools } from "./domains/script-catalogue.js";

vi.mock("./domains/scripts.js", () => ({
  listSavedScriptMetadataPage: vi.fn(),
}));

const listPage = vi.mocked(listSavedScriptMetadataPage);

function liveScript(record: Awaited<ReturnType<typeof loadInitialScriptCatalogue>>[number]) {
  return {
    scriptId: record.scriptId,
    name: record.name,
    description: record.reviewedDescription,
    language: record.language,
    runAs: record.runAs,
    runTimeVariables: record.runtimeVariables,
    tags: record.tags,
  };
}

describe("central SuperOps script catalogue sync", () => {
  beforeEach(() => {
    resetMemoryScriptCatalogueForTests();
    listPage.mockReset();
  });

  it("leaves the published snapshot unchanged when pagination is incomplete", async () => {
    listPage.mockResolvedValue({
      scripts: [{ scriptId: "live-1", name: "Live script" }],
      listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 2 },
    });

    const result = await syncScriptCatalogue();
    const store = getScriptCatalogueStore();
    expect(result.outcome).toBe("INCOMPLETE");
    expect(result.error).toMatch(/incomplete|duplicate|pagination/i);
    expect((await store.listPublished()).length).toBe(434);
    expect((await store.listQueue()).length).toBe(0);
    expect((await store.getStatus()).syncState).toBe("INCOMPLETE");
  });

  it("publishes a complete new SuperOps script immediately", async () => {
    const seed = await loadInitialScriptCatalogue();
    const records = [...seed, {
      version: 1 as const,
      scriptId: "new-live-script",
      name: "Zebra unique live metadata script",
      url: "https://taskgroup.superops.ai/#/rmm/script/new-live-script/detail",
      reviewedDescription: "Used by the fixture for a metadata publication check.",
      runtimeVariables: [],
      prerequisites: [],
      risks: [],
      alternatives: [],
      confidence: "Medium" as const,
      ticketReadyNextStep: "Review before use.",
      safetyFlags: [],
      status: "REVIEWED" as const,
      sourceReviewedAt: "2026-08-10T00:00:00.000Z",
    }];
    const pages = Array.from({ length: 5 }, (_, index) => records.slice(index * 100, (index + 1) * 100));
    listPage.mockImplementation(async (params = {}) => {
      const page = params.page ?? 1;
      return {
        scripts: pages[page - 1].map((record) => liveScript(record)),
        listInfo: { page, pageSize: 100, hasMore: page < pages.length, totalCount: records.length },
      };
    });

    const result = await syncScriptCatalogue();
    const store = getScriptCatalogueStore();
    expect(result.outcome).toBe("COMPLETE");
    expect((await store.listPublished()).length).toBe(435);
    expect(await store.getPublished("new-live-script")).toMatchObject({
      name: "Zebra unique live metadata script",
      reviewedDescription: "Used by the fixture for a metadata publication check.",
      url: "https://taskgroup.superops.ai/#/rmm/script/new-live-script/detail",
      runtimeVariables: [],
      status: "REVIEWED",
    });
    expect(await store.listQueue()).toHaveLength(0);
    const recommendation = await getScriptCatalogueTools().handleCall("superops_script_catalog_recommend", {
      ticketText: "Zebra unique live metadata",
    });
    expect(JSON.parse(recommendation.content[0].text).recommendation).toBe("FOUND");
  });

  it("updates the published description from SuperOps on a complete pull", async () => {
    const seed = await loadInitialScriptCatalogue();
    const target = seed[0];
    const pages = Array.from({ length: 5 }, (_, index) => seed.slice(index * 100, (index + 1) * 100));
    listPage.mockImplementation(async (params = {}) => {
      const page = params.page ?? 1;
      return {
        scripts: pages[page - 1].map((record) => ({
          ...liveScript(record),
          description: record.scriptId === target.scriptId
            ? "Updated directly from the SuperOps description field."
            : record.reviewedDescription,
        })),
        listInfo: { page, pageSize: 100, hasMore: page < pages.length, totalCount: seed.length },
      };
    });

    const result = await syncScriptCatalogue();
    const store = getScriptCatalogueStore();
    expect(result.outcome).toBe("COMPLETE");
    expect(await store.getPublished(target.scriptId)).toMatchObject({
      scriptId: target.scriptId,
      reviewedDescription: "Updated directly from the SuperOps description field.",
    });
    expect(await store.listQueue()).toHaveLength(0);
  });

  it("retires published records that are absent from a complete SuperOps pull", async () => {
    const seed = await loadInitialScriptCatalogue();
    const existing = seed[0];
    await getScriptCatalogueStore().seedPublished([existing]);
    listPage.mockResolvedValue({
      scripts: [{ scriptId: "remaining-live-script", name: "Remaining live script", description: "A remaining script." }],
      listInfo: { page: 1, pageSize: 100, hasMore: false, totalCount: 1 },
    });

    const result = await syncScriptCatalogue();
    const store = getScriptCatalogueStore();
    expect(result.outcome).toBe("COMPLETE");
    expect(await store.getPublished(existing.scriptId)).toBeUndefined();
    expect((await store.getPublished("remaining-live-script"))?.name).toBe("Remaining live script");
    expect(await store.listQueue()).toEqual([
      expect.objectContaining({ kind: "MISSING_RETIRED", scriptId: existing.scriptId }),
    ]);
  });
});
