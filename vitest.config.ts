import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./src/test-shims/cloudflare-workers.ts", import.meta.url)
      ),
    },
  },
  test: {
    // Synthetic producer credentials only. Every transport test mocks fetch.
    env: { DISPATCHER_TOKEN: "test-dispatcher-producer" },
    deps: {
      inline: ["@cloudflare/workers-oauth-provider"],
    },
    // The D1/SQLite integration check is a Node test and is run explicitly
    // with `node --test`; keep Vitest focused on the Worker/Node TypeScript
    // suite rather than asking Vite to bundle node:sqlite.
    exclude: ["**/node_modules/**", "**/dist/**", "diagnostics/**"],
  },
});
