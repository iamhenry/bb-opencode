import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isLockStale,
  lockPath,
  readLock,
  reclaimIfStale,
  sharedLockDir,
  writeLock,
} from "../src/process.js";

describe("lock reclaim", () => {
  it("treats a dead pid as stale (ISC-50.1)", () => {
    expect(isLockStale({ pid: 99999999, port: 1, startedAt: new Date().toISOString() })).toBe(
      true,
    );
  });

  it("removes a stale lock file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bb-oc-lock-"));
    writeLock(dir, { pid: 99999999, port: 1, startedAt: new Date().toISOString() });
    expect(await reclaimIfStale(dir)).toBe(true);
    expect(readLock(dir)).toBeUndefined();
    writeFileSync(join(dir, "keep"), "x");
  });

  it("uses one host-wide lock path (ISC-50, ISC-62)", () => {
    expect(lockPath("/tmp/a")).toBe(lockPath("/tmp/b"));
    expect(lockPath("/tmp/a").startsWith(sharedLockDir())).toBe(true);
  });
});
