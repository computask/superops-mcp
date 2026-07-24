/**
 * Scripts Domain Tests
 *
 * Dedicated SuperOps saved-script tools and single-asset execution safety.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { getClient } from "../client.js";
import { getScriptsTools } from "./scripts.js";

const savedScript = {
  scriptId: "script-1",
  name: "Collect AI Audit",
  description: "Collects audit metadata",
  language: "PowerShell",
  runAs: "SYSTEM_USER",
  runTimeVariables: [],
  timeOut: 120,
  tags: ["Audit"],
};

const windowsAsset = {
  assetId: "asset-1",
  name: "DESKTOP-001",
  hostName: "DESKTOP-001",
  status: "ONLINE",
  platform: "Microsoft Windows 11 Pro",
  platformCategory: "WORKSTATION",
  client: { accountId: "client-1", name: "Acme" },
};

function listResponse(scripts = [savedScript], hasMore = false) {
  return {
    getScriptList: {
      scripts,
      listInfo: { page: 1, pageSize: 500, hasMore, totalCount: scripts.length },
    },
  };
}

function typedListResponse(scripts = [savedScript], hasMore = false) {
  return {
    getScriptListByType: {
      scripts,
      listInfo: { page: 1, pageSize: 500, hasMore, totalCount: scripts.length },
    },
  };
}

function assetResponse(asset = windowsAsset) {
  return { getAsset: asset };
}

describe("Scripts Domain", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = { query: vi.fn(), mutate: vi.fn() };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
  });

  it("returns dedicated script tools with read-only tools separate from execution", () => {
    const domain = getScriptsTools();
    expect(domain.tools.map((tool) => tool.name)).toEqual([
      "superops_scripts_list",
      "superops_scripts_get",
      "superops_scripts_supported_targets",
      "superops_scripts_executions_list",
      "superops_scripts_execution_get",
      "superops_scripts_execute_on_asset",
    ]);
    expect(domain.tools.find((tool) => tool.name === "superops_scripts_execute_on_asset")?.inputSchema.required).toEqual([
      "scriptId",
      "expectedScriptName",
      "assetId",
      "expectedAssetNameOrHostname",
      "expectedClientAccountId",
      "reviewed",
    ]);
  });

  it("lists scripts by confirmed getScriptListByType without returning script source", async () => {
    mockClient.query.mockResolvedValueOnce(typedListResponse());
    const result = await getScriptsTools().handleCall("superops_scripts_list", {
      type: "WINDOWS",
      search: "audit",
      max: 200,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining("getScriptListByType"), {
      input: { type: "WINDOWS", listInfo: { page: 2, pageSize: 200 } },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.scripts).toHaveLength(1);
    expect(parsed.scripts[0]).toMatchObject({ scriptId: "script-1", contentsReturned: false });
    expect(parsed.scripts[0]).not.toHaveProperty("readMe");
    expect(parsed.scripts[0]).not.toHaveProperty("scriptText");
  });

  it("rejects arbitrary script text before any SuperOps read or write", async () => {
    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetId: "asset-1",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
      scriptText: "Write-Host bad",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("scriptText is not accepted");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("rejects bulk asset inputs before any SuperOps read or write", async () => {
    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetIds: ["asset-1", "asset-2"],
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("assetIds is not accepted");
    expect(mockClient.query).not.toHaveBeenCalled();
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("requires scriptId and assetId before execution", async () => {
    const missingScript = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      assetId: "asset-1",
      expectedScriptName: "Collect AI Audit",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });
    expect(missingScript.isError).toBe(true);
    expect(missingScript.content[0].text).toContain("scriptId is required");

    const missingAsset = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });
    expect(missingAsset.isError).toBe(true);
    expect(missingAsset.content[0].text).toContain("assetId is required");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("fails client mismatch before execution", async () => {
    mockClient.query
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(assetResponse({ ...windowsAsset, client: { accountId: "other-client", name: "Other Client" } }));

    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetId: "asset-1",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Client mismatch");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("fails platform mismatch before execution", async () => {
    mockClient.query
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(assetResponse())
      .mockResolvedValueOnce(typedListResponse([], false));

    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetId: "asset-1",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Script not found for exact scriptId script-1");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("fails ambiguous script metadata before execution", async () => {
    mockClient.query.mockResolvedValueOnce(listResponse([savedScript, { ...savedScript }]));

    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetId: "asset-1",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Ambiguous script identity");
    expect(mockClient.mutate).not.toHaveBeenCalled();
  });

  it("submits a confirmed saved script to one asset and returns the execution ID", async () => {
    mockClient.query
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(assetResponse())
      .mockResolvedValueOnce(typedListResponse());
    mockClient.mutate.mockResolvedValueOnce({
      runScriptOnAsset: {
        actionConfigId: "exec-1",
        script: { scriptId: "script-1", name: "Collect AI Audit", language: "PowerShell" },
        scriptArguments: [{ name: "secret", value: "sensitive" }],
        addedBy: { name: "Technician" },
      },
    });

    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetId: "asset-1",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });

    expect(result.isError).not.toBe(true);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    expect(mockClient.mutate).toHaveBeenCalledWith(expect.stringContaining("runScriptOnAsset"), {
      input: { assetId: "asset-1", scriptId: "script-1" },
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.executionId).toBe("exec-1");
    expect(parsed.statusTool).toBe("superops_scripts_execution_get");
    expect(parsed.runScriptOnAsset.scriptArguments[0]).toEqual({ name: "secret", value: "[redacted]" });
  });

  it("does not retry an uncertain execution submission", async () => {
    mockClient.query
      .mockResolvedValueOnce(listResponse())
      .mockResolvedValueOnce(assetResponse())
      .mockResolvedValueOnce(typedListResponse());
    mockClient.mutate.mockRejectedValueOnce(new Error("request timeout"));

    const result = await getScriptsTools().handleCall("superops_scripts_execute_on_asset", {
      scriptId: "script-1",
      expectedScriptName: "Collect AI Audit",
      assetId: "asset-1",
      expectedAssetNameOrHostname: "DESKTOP-001",
      expectedClientAccountId: "client-1",
      reviewed: true,
    });

    expect(result.isError).toBe(true);
    expect(mockClient.mutate).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ uncertainSubmission: true, retryAttempted: false, replaySafe: false });
  });

  it("retrieves execution status without resubmitting", async () => {
    mockClient.query.mockResolvedValueOnce({
      getAssetActivity: {
        activities: [
          {
            activityId: "activity-1",
            module: "SCRIPT",
            activityType: "RUN_SCRIPT",
            createdTime: "2026-07-24T10:00:00Z",
            activityData: {
              actionConfigId: "exec-1",
              script: { scriptId: "script-1", name: "Collect AI Audit" },
              status: "SUCCESS",
              output: "Completed",
            },
          },
        ],
        listInfo: { page: 1, pageSize: 500, hasMore: false, totalCount: 1 },
      },
    });

    const result = await getScriptsTools().handleCall("superops_scripts_execution_get", {
      assetId: "asset-1",
      executionId: "exec-1",
    });

    expect(result.isError).not.toBe(true);
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining("getAssetActivity"), {
      input: { assetId: "asset-1", listInfo: { page: 1, pageSize: 500 } },
    });
    expect(mockClient.mutate).not.toHaveBeenCalled();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed).toMatchObject({ assetId: "asset-1", executionId: "exec-1", status: "SUCCESS", output: "Completed" });
  });
});
