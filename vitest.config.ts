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
    deps: {
      inline: ["@cloudflare/workers-oauth-provider"],
    },
  },
});
