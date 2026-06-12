/**
 * Technicians Domain Tests
 *
 * Tests for technician management tools.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    query: vi.fn(),
    mutate: vi.fn(),
  })),
}));

import { getClient } from "../client.js";
import { getTechniciansTools } from "./technicians.js";

describe("Technicians Domain", () => {
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
    const domain = getTechniciansTools();

    expect(domain.tools.map((tool) => tool.name)).toEqual([
      "superops_technicians_list",
      "superops_technicians_get",
      "superops_technicians_groups",
    ]);
  });

  it("uses userList with page/pageSize and local team filtering", async () => {
    mockClient.query.mockResolvedValue({
      getTechnicianList: {
        userList: [
          {
            userId: "tech-1",
            firstName: "John",
            name: "John Doe",
            email: "john@example.com",
            team: { teamId: "team-123", name: "Support" },
          },
          {
            userId: "tech-2",
            firstName: "Jane",
            name: "Jane Doe",
            email: "jane@example.com",
            team: { teamId: "team-456", name: "Projects" },
          },
        ],
        listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 2 },
      },
    });

    const domain = getTechniciansTools();
    const result = await domain.handleCall("superops_technicians_list", {
      teamId: "team-123",
      max: 25,
      page: 2,
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTechnicianList"),
      { input: { page: 2, pageSize: 25 } }
    );
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("first");
    expect(mockClient.query.mock.calls[0][1].input).not.toHaveProperty("filter");
    expect(result.content[0].text).toContain("John Doe");
    expect(result.content[0].text).not.toContain("Jane Doe");
  });

  it("uses documented technician fields", async () => {
    mockClient.query.mockResolvedValue({
      getTechnicianList: {
        userList: [],
        listInfo: { page: 1, pageSize: 50, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getTechniciansTools();
    await domain.handleCall("superops_technicians_list", { page: 1 });

    const queryArg = mockClient.query.mock.calls[0][0];
    expect(queryArg).toContain("userId");
    expect(queryArg).toContain("firstName");
    expect(queryArg).toContain("contactNumber");
    expect(queryArg).toContain("businessFunction");
    expect(queryArg).not.toContain("isActive");
    expect(queryArg).not.toContain("ticketCount");
  });

  it("gets a technician by querying the documented list operation and matching userId", async () => {
    mockClient.query.mockResolvedValue({
      getTechnicianList: {
        userList: [
          {
            userId: "tech-123",
            firstName: "Jane",
            name: "Jane Smith",
            email: "jane@example.com",
          },
        ],
        listInfo: { page: 1, pageSize: 500, hasMore: false, totalCount: 1 },
      },
    });

    const domain = getTechniciansTools();
    const result = await domain.handleCall("superops_technicians_get", {
      technicianId: "tech-123",
    });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTechnicianList"),
      { input: { page: 1, pageSize: 500 } }
    );
    expect(mockClient.query.mock.calls[0][0]).not.toContain("query getTechnician(");
    expect(result.content[0].text).toContain("Jane Smith");
  });

  it("returns an error when the requested technician is not in the returned page", async () => {
    mockClient.query.mockResolvedValue({
      getTechnicianList: {
        userList: [],
        listInfo: { page: 1, pageSize: 500, hasMore: false, totalCount: 0 },
      },
    });

    const domain = getTechniciansTools();
    const result = await domain.handleCall("superops_technicians_get", {
      technicianId: "missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Technician not found");
  });

  it("uses the documented non-paginated technician group query", async () => {
    mockClient.query.mockResolvedValue({
      getTechnicianGroupList: [
        { groupId: "group-1", name: "Support Team" },
        { groupId: "group-2", name: "Projects Team" },
      ],
    });

    const domain = getTechniciansTools();
    const result = await domain.handleCall("superops_technicians_groups", { max: 1 });

    expect(mockClient.query).toHaveBeenCalledWith(
      expect.stringContaining("getTechnicianGroupList")
    );
    expect(mockClient.query.mock.calls[0][0]).not.toContain("getTechGroupList");
    expect(mockClient.query.mock.calls[0]).toHaveLength(1);
    expect(result.content[0].text).toContain("Support Team");
    expect(result.content[0].text).not.toContain("Projects Team");
  });

  it("handles unknown tools and API errors", async () => {
    const domain = getTechniciansTools();
    const unknown = await domain.handleCall("unknown_tool", {});
    expect(unknown.isError).toBe(true);

    mockClient.query.mockRejectedValue(new Error("Technician API failed"));
    const failed = await domain.handleCall("superops_technicians_list", {});
    expect(failed.isError).toBe(true);
    expect(failed.content[0].text).toContain("Technician API failed");
  });
});
