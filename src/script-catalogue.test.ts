import { beforeEach, describe, expect, it } from "vitest";
import { getScriptCatalogueTools } from "./domains/script-catalogue.js";
import {
  getScriptCatalogueStore,
  resetMemoryScriptCatalogueForTests,
  runWithScriptCatalogueStore,
  type ScriptCatalogueRecord,
} from "./script-catalogue-store.js";

const baseRecord: ScriptCatalogueRecord = {
  version: 1,
  scriptId: "123456789",
  name: "Windows DHCP renew and DNS refresh",
  url: "https://taskgroup.superops.ai/#/rmm/script/123456789/detail",
  reviewedDescription: "Renews the Windows computer DHCP lease, flushes the DNS resolver cache, and reports IPv4 DNS server addresses.",
  platform: "WINDOWS",
  language: "PowerShell",
  runAs: "SYSTEM",
  runtimeVariables: [],
  tags: ["network", "dns"],
  prerequisites: [],
  risks: [],
  alternatives: [],
  confidence: "High",
  ticketReadyNextStep: "Confirm the target Windows asset before separately approved execution.",
  safetyFlags: [],
  status: "REVIEWED",
  sourceReviewedAt: "2026-08-10T00:00:00.000Z",
};

function parsed(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text) as Record<string, unknown>;
}

describe("central SuperOps script catalogue", () => {
  beforeEach(() => resetMemoryScriptCatalogueForTests());

  it("returns an exact read-only match from the published snapshot without API credentials", async () => {
    await runWithScriptCatalogueStore({
      fn: async () => {
        await getScriptCatalogueStore().seedPublished([baseRecord]);
        const result = await getScriptCatalogueTools().handleCall("superops_script_catalog_recommend", {
          ticketText: "Windows DHCP renew to get a new DNS IP from the router",
          platform: "WINDOWS",
        });
        const output = parsed(result);
        expect(output.recommendation).toBe("FOUND");
        const bestMatch = output.bestMatch as Record<string, unknown>;
        expect(bestMatch.scriptName).toBe(baseRecord.name);
        expect(bestMatch.scriptId).toBe(baseRecord.scriptId);
        expect(bestMatch.scriptUrl).toBe(baseRecord.url);
        expect(bestMatch.runtimeVariables).toEqual(["None configured."]);
        expect(output.readOnly).toBe(true);
      },
    });
  });

  it("does not present a flagged script as FOUND", async () => {
    await runWithScriptCatalogueStore({
      fn: async () => {
        await getScriptCatalogueStore().seedPublished([{
          ...baseRecord,
          name: "TEST - Force reboot workstation",
          reviewedDescription: "TEST script that forcefully restarts the Windows workstation.",
          safetyFlags: ["TEST", "FORCED_REBOOT"],
          risks: ["Test entry; forceful restart may interrupt the user."],
        }]);
        const result = await getScriptCatalogueTools().handleCall("superops_script_catalog_recommend", {
          ticketText: "forcefully restart the Windows workstation",
          platform: "WINDOWS",
        });
        const output = parsed(result);
        expect(output.recommendation).toBe("NEEDS_DETAILS");
        expect(output.detailRequests).toEqual(expect.arrayContaining([
          expect.stringMatching(/TEST/i),
          expect.stringMatching(/restart/i),
        ]));
      },
    });
  });

  it("returns exact reviewed records and central freshness status", async () => {
    await runWithScriptCatalogueStore({
      fn: async () => {
        await getScriptCatalogueStore().seedPublished([baseRecord]);
        const tools = getScriptCatalogueTools();
        const recordResult = await tools.handleCall("superops_script_catalog_get", { scriptId: baseRecord.scriptId });
        expect(parsed(recordResult).scriptId).toBe(baseRecord.scriptId);
        const statusResult = await tools.handleCall("superops_script_catalog_status", {});
        expect(parsed(statusResult).publishedCount).toBe(1);
        expect(parsed(statusResult).syncState).toBe("NEVER");
      },
    });
  });
});
