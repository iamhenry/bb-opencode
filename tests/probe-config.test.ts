import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { probeOpenCode, summarizeOpenCodeConfig } from "../src/probe.js";

describe("probe needsConfiguration (ISC-53)", () => {
  it("is true when OPENCODE_BIN points at a missing file", async () => {
    const previous = process.env.OPENCODE_BIN;
    process.env.OPENCODE_BIN = "/tmp/bb-oc-missing-opencode-binary";
    try {
      const result = await probeOpenCode({
        dataDir: "/tmp/bb-oc-probe-missing",
        acquire: () => {
          throw new Error("should not attach");
        },
      });
      expect(result.needsConfiguration).toBe(true);
      expect(result.binaryPath).toBeUndefined();
      expect(result.spawned).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previous;
    }
  });

  it("spawns a serve from probe when none is attached",
    async () => {
      const previous = process.env.OPENCODE_BIN;
      const previousHome = process.env.HOME;
      const home = mkdtempSync(join(tmpdir(), "bb-oc-probe-home-"));
      process.env.HOME = home;
      // A binary that exists but exits immediately: prove the probe attempted
      // a spawn (serve log records the child's output) without leaving
      // stray processes.
      process.env.OPENCODE_BIN = "/usr/bin/false";
      try {
        const result = await probeOpenCode({
          dataDir: join(home, "data"),
          acquire: () => {
            throw new Error("should not attach");
          },
        });
        expect(result.spawned).toBe(false);
        expect(result.error).toMatch(/serve exited/i);
        expect(
          result.serveLog.some((line) => line.length > 0),
        ).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.OPENCODE_BIN;
        else process.env.OPENCODE_BIN = previous;
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
      }
    },
  );

  it("summarizes permission config for status",
    () => {
      expect(
        summarizeOpenCodeConfig({
          permission: { bash: "deny" },
          model: "opencode/gpt-5",
        }),
      ).toContain("bash");
    },
  );
});
