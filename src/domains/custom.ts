/**
 * SuperOps.ai Custom Domain
 *
 * Advanced tools for running custom GraphQL queries and mutations.
 */

import { getClient } from "../client.js";
import { sanitizeError } from "../audit.js";
import type { DomainTools } from "../types.js";

/** Opaque custom mutations cannot safely derive a verification target. */
function customMutationFailure(error: unknown): Record<string, unknown> {
  const candidate = error as { name?: unknown; status?: unknown } | null;
  const name = typeof candidate?.name === "string" ? candidate.name : "";
  const status = typeof candidate?.status === "number" ? candidate.status : undefined;
  const conclusivelyRejected = name === "SuperOpsError" ||
    (name === "SuperOpsHttpError" && status !== undefined && status < 500);

  return {
    errorClass: conclusivelyRejected ? "SuperOpsGraphQLError" : "AmbiguousWrite",
    writeAttempted: true,
    writeMayHaveSucceeded: !conclusivelyRejected,
    partialWrite: !conclusivelyRejected,
    retryable: false,
    retrySafe: false,
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
      const client = getClient();

      try {
        switch (name) {
          case "superops_custom_query": {
            const params = args as {
              query: string;
              variables?: Record<string, unknown>;
            };

            const response = await client.query(params.query, params.variables);

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(response, null, 2),
                },
              ],
            };
          }

          case "superops_custom_mutation": {
            const params = args as {
              mutation: string;
              variables?: Record<string, unknown>;
            };

            try {
              const response = await client.mutate(params.mutation, params.variables);
              return {
                content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              };
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
