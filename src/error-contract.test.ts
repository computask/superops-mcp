import { describe, expect, it } from "vitest";
import { SuperOpsError, SuperOpsHttpError } from "./client.js";
import { createSafeToolErrorMetadata, safeSuperOpsErrorMetadata } from "./error-contract.js";
import { boundedToolResult } from "./utils/tool-result.js";

describe("safe read error contract", () => {
  it("projects metadata without copying provider reasons, bodies or credentials", () => {
    const safe = createSafeToolErrorMetadata({ errorClass: "SuperOpsRateLimit", rateLimited: true,
      retryable: true, retryScope: "read", retryAfterSeconds: 999999, attempts: 3,
      finalReason: "private customer detail", body: "private body", authorization: "synthetic secret" });
    expect(safe).toMatchObject({ retryScope: "read", retryable: true, retryAfterSeconds: 86400, attempts: 3 });
    expect(JSON.stringify(safe)).not.toMatch(/private|secret|authorization|finalReason/);
  });
  it("never grants write replay from a rate-limit error", () => {
    expect(safeSuperOpsErrorMetadata(new SuperOpsHttpError("private reason", 429, "", 120), false))
      .toMatchObject({ rateLimited: true, retryable: false, retryScope: "none", retryAfterSeconds: 120 });
    expect(safeSuperOpsErrorMetadata(new SuperOpsError("Exception", "DataFetchingException", undefined,
      { errorType: "rate_limit_exceeded" }), true)).toMatchObject({ rateLimited: true, retryScope: "read" });
    expect(safeSuperOpsErrorMetadata(new Error("INVALID_ARGUMENT rate limited"), true)).toBeUndefined();
  });
  it("does not mistake unrelated codes for throttling", () => {
    expect(safeSuperOpsErrorMetadata(new SuperOpsError("Failed", "corporate_failure"), true))
      .toMatchObject({ rateLimited: false, retryable: false });
  });
  it("accounts for structured payload bytes and omits both channels when oversized", () => {
    const result = boundedToolResult({ content: [{ type: "text", text: "small" }], structuredContent: { body: "x".repeat(1024) } }, 100);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0].text).not.toContain("x".repeat(100));
  });
});
