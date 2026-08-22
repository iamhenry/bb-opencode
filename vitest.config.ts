import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@get-bb/plugin-sdk/provider-bridge": join(
        root,
        "tests/shims/provider-bridge.ts",
      ),
    },
  },
  test: {
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts"],
    exclude: [
      "node_modules/**",
      "dist/**",
      "tests/provider-bridge.conformance.test.ts",
    ],
    environment: "node",
  },
});
