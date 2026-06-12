/**
 * Clients Domain Tests
 *
 * Tests for client (account) management tools.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { getClient } from "../client.js";
import { getClientsTools } from "./clients.js";

describe("Clients Domain", () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; mutate: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    mockClient = {
      query: vi.fn(),
      mutate: vi.fn(),
    };
    vi.mocked(getClient).mockReturnValue(mockClient as unknown as ReturnType<typeof getClient>);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns the expected public tools", () => {
    const domain = getClientsTools();

    expect(domain.tools.map((tool) => tool.name)).toEqual([
      "superops_clients_list",
      "superops_clients_get",
      "superops_clients_search",
    ]);
  });

  it("uses page/pageSize list variables and local status filtering", async () => {
    mockClient.query.mockResolvedValue({
      getClientList: {
        clients: [
          { accountId: "1", name: "Active Client", status: "Active" },
          { accountId: "2", name: "Inactive Client", status: "Inactive" },
        ],
        listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getClientsTools();
    const result = await domain.handleCall("superops_clients_list", {
      status: "Active",
      max: 100,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getClientList"),
      { input: { page: 2, pageSize: 100 } }
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("first");
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("filter");
    expect(result.content[0].text).toContain("Active Client");
    expect(result.content[0].text).not.toContain("Inactive Client");
  });

  it("caps list pageSize at 500", async () => {
    mockClient.query.mockResolvedValue({
      getClientList: {
        clients: [],
        listInfo: { page: 1, pageSize: 500, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getClientsTools();
    await domain.handleCall("superops_clients_list", { max: 1000, page: 3 });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.any(String),
      { input: { page: 3, pageSize: 500 } }
    );
  });

  it("gets a client by documented ClientIdentifierInput", async () => {
    mockClient.query.mockResolvedValue({
      getClient: {
        accountId: "acc-123",
        name: "Test Company",
        status: "Active",
      },
    });

    const domain = getClientsTools();
    const result = await domain.handleCall("superops_clients_get", {
      accountId: "acc-123",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getClient"),
      { input: { accountId: "acc-123" } }
    );
    expect(result.content[0].text).toContain("Test Company");
  });

  it("searches locally without sending undocumented filter input", async () => {
    mockClient.query.mockResolvedValue({
      getClientList: {
        clients: [
          { accountId: "1", name: "Acme Corp", emailDomains: ["acme.test"] },
          { accountId: "2", name: "Other Corp", emailDomains: ["other.test"] },
        ],
        listInfo: { page: 1, pageSize: 20, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getClientsTools();
    const result = await domain.handleCall("superops_clients_search", {
      query: "acme",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.any(String),
      { input: { page: 1, pageSize: 20 } }
    );
    expect(result.content[0].text).toContain("Acme Corp");
    expect(result.content[0].text).not.toContain("Other Corp");
  });

  it("uses only documented client fields in built-in queries", async () => {
    mockClient.query.mockResolvedValue({
      getClient: { accountId: "1", name: "Test" },
    });

    const domain = getClientsTools();
    await domain.handleCall("superops_clients_get", { accountId: "1" });

    const queryArg = mockClient.query.mock.calls[0][0];
    expect(queryArg).toContain("accountId");
    expect(queryArg).toContain("name");
    expect(queryArg).toContain("emailDomains");
    expect(queryArg).toContain("hqSite");
    expect(queryArg).not.toContain("phone");
    expect(queryArg).not.toContain("website");
    expect(queryArg).not.toContain("sites");
  });

  it("handles unknown tools and API errors", async () => {
    const domain = getClientsTools();
    const unknown = await domain.handleCall("unknown_tool", {});
    expect(unknown.isError).toBe(true);

    mockClient.query.mockRejectedValue(new Error("API connection failed"));
    const failed = await domain.handleCall("superops_clients_list", {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("API connection failed");
  });
});
