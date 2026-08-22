import { describe, expect, it } from "vitest";
import { probeOpenCode } from "../src/probe.js";

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
    } finally {
      if (previous === undefined) delete process.env.OPENCODE_BIN;
      else process.env.OPENCODE_BIN = previous;
    }
  });
});
