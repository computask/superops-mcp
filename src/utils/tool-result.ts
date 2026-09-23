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

  // Preserve only scalar continuation metadata, never copy a large/sensitive
  // body into the limit error. Since no records are delivered, restart at the
  // original page, NOT the next page after the omitted records.
  let restartPage: number | undefined;
  let totalCount: number | undefined;
  let pageSize: number | undefined;
  for (const item of result.content) {
    if (textBytes(item.text) > 4 * MAX_TOOL_RESPONSE_BYTES) continue;
    try {
      const value = JSON.parse(item.text);
      const info = value?.listInfo ?? value?.pagination ?? value;
      if (Number.isSafeInteger(info?.page) && info.page >= 1) restartPage = info.page;
      if (Number.isSafeInteger(info?.pageSize) && info.pageSize >= 1 && info.pageSize <= 100) pageSize = info.pageSize;
      const count = info?.totalCount ?? info?.apiTotalCount;
      if (Number.isSafeInteger(count) && count >= 0) totalCount = count;
    } catch { /* Non-JSON tool results still receive a safe size-limit error. */ }
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          ok: false,
          error: "Tool response exceeded the serialized response limit.",
          responseOmitted: true,
          complete: false,
          truncated: true,
          recordsReturned: 0,
          truncationReason: "responseSizeLimit",
          nextPage: restartPage,
          totalCount,
          continuation: { page: restartPage, pageSize, action: "Repeat the original request with a smaller projection or page size; no returned records were delivered. Preserve the original filters and start position." },
          bytes,
          maxBytes,
        }),
      },
    ],
    isError: true,
  };
}
