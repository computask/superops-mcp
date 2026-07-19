#!/usr/bin/env node
/**
 * SuperOps.ai MCP Server
 *
 * This MCP server provides tools for interacting with SuperOps.ai PSA/RMM API.
 * All tools are listed upfront so they work with every MCP client, including
 * remote connectors (claude.ai, mcp-remote) that do not support dynamic
 * tool-list changes. A helper `superops_navigate` tool provides domain
 * discovery and guidance.
 *
 * The MCP server itself is built by the shared, side-effect-free factory in
 * `mcp-server.ts`, which is reused by the Cloudflare Workers entrypoint
 * (`worker.ts`).
 *
 * Supports both stdio and HTTP transports:
 * - stdio (default): For local Claude Desktop / CLI usage
 * - http: For hosted deployment with optional gateway auth
 *
 * Auth modes:
 * - env (default): Credentials from environment variables
 * - gateway: Credentials injected from request headers by the MCP gateway
 *   - Header: X-SuperOps-API-Token
 *   - Header: X-SuperOps-Subdomain
 *
 * Environment Variables:
 * - SuperOps API token secret: Your SuperOps.ai API token
 * - SUPEROPS_SUBDOMAIN: Your SuperOps.ai subdomain
 * - SUPEROPS_REGION: API region (us or eu, default: us)
 * - MCP_TRANSPORT: Transport mode (stdio or http, default: stdio)
 * - MCP_HTTP_PORT: HTTP port (default: 8080)
 * - MCP_HTTP_HOST: HTTP host (default: 0.0.0.0)
 * - AUTH_MODE: Authentication mode (env or gateway, default: env)
 * - MCP_ENABLED: Set false to disable MCP tool execution
 * - ENABLE_WRITE_TOOLS: Set false to block write-capable ticket tools
 * - ENABLE_CUSTOM_MUTATION: Set false to block custom GraphQL mutations
 */

import {
  createServer as createHttpServer,
  IncomingMessage,
  ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

import { getCredentials, runWithCredentials } from "./client.js";
import { createMcpServer } from "./mcp-server.js";
import { runWithAuditContext, runtimeFlagsFromEnv } from "./audit.js";
import { envTenantOwnerHash, gatewayOwnerHash } from "./operation-store.js";

/**
 * Start the server with stdio transport (default).
 */
async function startStdioTransport(): Promise<void> {
  const creds = getCredentials();
  const ownerHash = creds ? await envTenantOwnerHash(creds) : undefined;
  await runWithAuditContext({ ownerHash, ownerIdentityRequired: true }, async () => {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("SuperOps.ai MCP server running on stdio (all tools available)");
  });
}

/**
 * Start the server with HTTP Streamable transport.
 *
 * In gateway mode (AUTH_MODE=gateway), credentials are extracted from
 * request headers and isolated per-request via AsyncLocalStorage.
 * Credentials are NEVER stored in process.env or shared state.
 */
async function startHttpTransport(): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT || "8080", 10);
  const host = process.env.MCP_HTTP_HOST || "0.0.0.0";
  const isGatewayMode = process.env.AUTH_MODE === "gateway";
  const requestId = (req: IncomingMessage): string => {
    const value = req.headers["x-request-id"];
    if (Array.isArray(value)) {
      return value[0] || randomUUID();
    }
    return value || randomUUID();
  };

  const httpServer = createHttpServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(
        req.url || "/",
        `http://${req.headers.host || "localhost"}`
      );

      // Health check - no auth required
      if (url.pathname === "/health") {
        const creds = getCredentials();
        const statusCode = isGatewayMode || creds ? 200 : 503;

        res.writeHead(statusCode, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: isGatewayMode || creds ? "ok" : "degraded",
            transport: "http",
            authMode: isGatewayMode ? "gateway" : "env",
            timestamp: new Date().toISOString(),
            credentials: {
              configured: isGatewayMode || !!creds,
            },
            version: "1.0.0",
          })
        );
        return;
      }

      // MCP endpoint - each request gets a fresh server + transport
      if (url.pathname === "/mcp") {
        const apiTokenHeader = req.headers["x-superops-api-token"];
        const subdomainHeader = req.headers["x-superops-subdomain"];
        const apiToken = typeof apiTokenHeader === "string" && apiTokenHeader.trim()
          ? apiTokenHeader.trim()
          : undefined;
        const subdomain = typeof subdomainHeader === "string" && subdomainHeader.trim()
          ? subdomainHeader.trim()
          : undefined;
        const envCredentials = !isGatewayMode ? getCredentials() : undefined;
        const ownerHash = isGatewayMode
          ? apiToken && subdomain
            ? await gatewayOwnerHash({ apiToken, subdomain })
            : undefined
          : envCredentials
            ? await envTenantOwnerHash(envCredentials)
            : undefined;
        await runWithAuditContext(
          {
            requestId: requestId(req),
            ownerHash,
            ownerIdentityRequired: true,
            ...runtimeFlagsFromEnv({
              MCP_ENABLED: process.env.MCP_ENABLED,
              ENABLE_WRITE_TOOLS: process.env.ENABLE_WRITE_TOOLS,
              ENABLE_CUSTOM_MUTATION: process.env.ENABLE_CUSTOM_MUTATION,
            }),
          },
          async () => {
            // Gateway mode: extract credentials from headers
            if (isGatewayMode) {
              if (!apiToken || !subdomain) {
                res.writeHead(401, { "Content-Type": "application/json" });
                res.end(
                  JSON.stringify({
                    error: "Missing credentials",
                    message:
                      "Gateway mode requires X-SuperOps-API-Token and X-SuperOps-Subdomain headers",
                    required: ["X-SuperOps-API-Token", "X-SuperOps-Subdomain"],
                  })
                );
                return;
              }

              const creds = { apiToken, subdomain };

              // Run the entire MCP request inside AsyncLocalStorage context
              // so getCredentials()/getClient() pick up per-request creds
              await runWithCredentials(creds, async () => {
                const perRequestServer = createMcpServer();
                const transport = new StreamableHTTPServerTransport({
                  sessionIdGenerator: () => randomUUID(),
                  enableJsonResponse: true,
                });
                await perRequestServer.connect(transport);
                await transport.handleRequest(req, res);
                await perRequestServer.close();
              });
              return;
            }

            // Non-gateway mode: single server, env-var credentials
            const perRequestServer = createMcpServer();
            const transport = new StreamableHTTPServerTransport({
              sessionIdGenerator: () => randomUUID(),
              enableJsonResponse: true,
            });
            await perRequestServer.connect(transport);
            await transport.handleRequest(req, res);
            await perRequestServer.close();
          }
        );
        return;
      }

      // 404 for everything else
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "Not found",
          endpoints: ["/mcp", "/health"],
        })
      );
    }
  );

  await new Promise<void>((resolve) => {
    httpServer.listen(port, host, () => {
      console.error(
        `SuperOps.ai MCP server listening on http://${host}:${port}/mcp`
      );
      console.error(
        `Health check available at http://${host}:${port}/health`
      );
      console.error(
        `Authentication mode: ${isGatewayMode ? "gateway credentials from request headers" : "env credentials from configured runtime"}`
      );
      resolve();
    });
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.error("Shutting down SuperOps.ai MCP server...");
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * Main entry point - select transport based on MCP_TRANSPORT env var.
 */
async function main() {
  const transport = process.env.MCP_TRANSPORT || "stdio";

  if (transport === "http") {
    await startHttpTransport();
  } else {
    await startStdioTransport();
  }
}

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
