import type { ToolResult } from "../audit.js";

export const MAX_TOOL_RESPONSE_BYTES = 1024 * 1024;

function textBytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function resultBytes(result: ToolResult): number {
  return result.content.reduce((sum, item) => sum + textBytes(item.text), 0);
}

export function boundedToolResult(
  result: ToolResult,
  maxBytes = MAX_TOOL_RESPONSE_BYTES
): ToolResult {
  const bytes = resultBytes(result);
  if (bytes <= maxBytes) {
    return result;
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: "Tool response exceeded the serialized response limit.",
          responseOmitted: true,
          bytes,
          maxBytes,
        }),
      },
    ],
    isError: true,
  };
}
