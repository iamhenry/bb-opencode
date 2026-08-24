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

  it("never spawns a serve from probe/status",
    async () => {
      const previous = process.env.OPENCODE_BIN;
      const previousHome = process.env.HOME;
      const home = mkdtempSync(join(tmpdir(), "bb-oc-probe-home-"));
      process.env.HOME = home;
      process.env.OPENCODE_BIN = process.execPath;
      let acquired = 0;
      try {
        const result = await probeOpenCode({
          dataDir: join(home, "data"),
          acquire: () => {
            acquired += 1;
            throw new Error("should not attach");
          },
        });
        expect(acquired).toBe(0);
        expect(result.attached).toBe(false);
        expect(result.spawned).toBe(false);
        expect(result.error).toMatch(/not attached/i);
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
