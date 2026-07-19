/**
 * SuperOps.ai Custom Domain
 *
 * Advanced tools for running custom GraphQL queries and mutations.
 */

import { getClient } from "../client.js";
import { sanitizeError } from "../audit.js";
import type { DomainTools } from "../types.js";

const MAX_CUSTOM_DOCUMENT_BYTES = 64 * 1024;
const MAX_CUSTOM_VARIABLE_BYTES = 128 * 1024;
const MAX_CUSTOM_RESPONSE_BYTES = 1024 * 1024;

function jsonBytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Number.POSITIVE_INFINITY; }
}

function validateCustomInput(document: string, variables: Record<string, unknown> | undefined): string | undefined {
  if (new TextEncoder().encode(document).byteLength > MAX_CUSTOM_DOCUMENT_BYTES) {
    return `Custom GraphQL document exceeds ${MAX_CUSTOM_DOCUMENT_BYTES} bytes.`;
  }
  if (jsonBytes(variables ?? {}) > MAX_CUSTOM_VARIABLE_BYTES) {
    return `Custom GraphQL variables exceed ${MAX_CUSTOM_VARIABLE_BYTES} bytes.`;
  }
}

function boundedCustomResponse(value: unknown, oversizedMetadata: Record<string, unknown> = {}) {
  const text = JSON.stringify(value, null, 2);
  if (new TextEncoder().encode(text).byteLength > MAX_CUSTOM_RESPONSE_BYTES) {
    return {
      content: [{ type: "text" as const, text: JSON.stringify({
        error: "Custom GraphQL response exceeded the configured response limit.",
        responseOmitted: true,
        maxBytes: MAX_CUSTOM_RESPONSE_BYTES,
        ...oversizedMetadata,
      }) }],
      isError: true,
    };
  }
  return { content: [{ type: "text" as const, text }] };
}

/** Opaque custom mutations cannot safely derive a verification target. */
function customMutationFailure(error: unknown): Record<string, unknown> {
  const candidate = error as { name?: unknown; status?: unknown; code?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const code = typeof candidate?.code === "string" ? candidate.code : "";
  const conclusivelyRejected =
    (name === "SuperOpsError" &&
      /THROTTL|VALIDATION|BAD_USER_INPUT|UNAUTHENTICATED|FORBIDDEN/i.test(code)) ||
    (name === "SuperOpsHttpError" && status !== undefined && status >= 400 && status < 500);

  return {
    errorClass: conclusivelyRejected ? "SuperOpsGraphQLError" : "AmbiguousWrite",
    writeAttempted: true,
    writeMayHaveSucceeded: !conclusivelyRejected,
    writeCount: { attempted: 1, maximum: 1, exact: true },
    verification: {
      performed: false,
      possible: false,
      verified: null,
      reason: "Opaque custom mutation has no canonical final-state target.",
    },
    reliableResponseReceived: conclusivelyRejected,
    partialWrite: !conclusivelyRejected,
    replaySafe: conclusivelyRejected,
    classification: conclusivelyRejected ? "RejectedSynchronousWrite" : "AmbiguousSynchronousWrite",
    retryable: false,
    retrySafe: conclusivelyRejected,
    finalOutcome: conclusivelyRejected ? "WriteRejected" : "AmbiguousWriteUnresolved",
    message: sanitizeError(error),
  };
}

export function getCustomTools(): DomainTools {
  return {
    tools: [
      {
        name: "superops_custom_query",
        description:
          "Run a custom GraphQL query against the SuperOps.ai API. For advanced use cases not covered by standard tools.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The GraphQL query string",
            },
            variables: {
              type: "object",
              description: "Variables to pass to the query",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "superops_custom_mutation",
        description:
          "Run a custom GraphQL mutation against the SuperOps.ai API. For advanced write operations not covered by standard tools.",
        inputSchema: {
          type: "object",
          properties: {
            mutation: {
              type: "string",
              description: "The GraphQL mutation string",
            },
            variables: {
              type: "object",
              description: "Variables to pass to the mutation",
            },
          },
          required: ["mutation"],
        },
      },
    ],

    async handleCall(name, args) {
      try {
        switch (name) {
          case "superops_custom_query": {
            const params = args as {
              query: string;
              variables?: Record<string, unknown>;
            };

            const inputError = validateCustomInput(params.query, params.variables);
            if (inputError) return { content: [{ type: "text", text: inputError }], isError: true };
            const response = await getClient().query(params.query, params.variables);
            return boundedCustomResponse(response);
          }

          case "superops_custom_mutation": {
            const params = args as {
              mutation: string;
              variables?: Record<string, unknown>;
            };

            try {
              const inputError = validateCustomInput(params.mutation, params.variables);
              if (inputError) return { content: [{ type: "text", text: inputError }], isError: true };
              const response = await getClient().mutate(params.mutation, params.variables);
              const responseObject = response !== null && typeof response === "object" && !Array.isArray(response)
                ? response as Record<string, unknown>
                : { result: response };
              const writeContract = {
                writeAttempted: true,
                writeMayHaveSucceeded: true,
                reliableResponseReceived: true,
                replaySafe: false,
                partialWrite: false,
                writeCount: { attempted: 1, maximum: 1, exact: true },
                verification: {
                  performed: false,
                  possible: false,
                  verified: null,
                  reason: "Opaque custom mutation has no canonical final-state target.",
                },
                failureClassification: null,
              };
              return boundedCustomResponse({ ...responseObject, ...writeContract }, writeContract);
            } catch (error) {
              return {
                content: [{ type: "text", text: JSON.stringify(customMutationFailure(error)) }],
                isError: true,
              };
            }
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown custom tool: ${name}` }],
              isError: true,
            };
        }
      } catch (error) {
        const message = sanitizeError(error);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        };
      }
    },
  };
}
