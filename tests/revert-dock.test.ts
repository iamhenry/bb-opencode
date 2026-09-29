import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dock = readFileSync(
  new URL("../src/app/revert-dock.tsx", import.meta.url),
  "utf8",
);

describe("OpenCode revert dock", () => {
  it("keeps Restore on clear and exposes a separate Confirm action", () => {
    expect(dock).toContain('rpc.call("redo", { threadId })');
    expect(dock).toContain('rpc.call("revertCommit", { threadId })');
    expect(dock).toContain('"Restore"');
    expect(dock).toContain('"Confirm"');
    expect(dock).toContain('"Confirming…"');
  });
});
