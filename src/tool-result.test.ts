import { describe, expect, it } from "vitest";
import { boundedToolResult, MAX_TOOL_RESPONSE_BYTES } from "./utils/tool-result.js";


describe("boundedToolResult", () => {
  it("omits oversized serialized tool responses", () => {
    const result = boundedToolResult({
      content: [{ type: "text", text: "x".repeat(MAX_TOOL_RESPONSE_BYTES + 1) }],
    });
    const parsed = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(parsed).toMatchObject({
      responseOmitted: true,
      maxBytes: MAX_TOOL_RESPONSE_BYTES,
    });
    expect(result.content[0].text).not.toContain("x".repeat(100));
  });
});
