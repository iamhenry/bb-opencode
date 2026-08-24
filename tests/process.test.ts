import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attachOrSpawn,
  claimPath,
  isLockStale,
  lockPath,
  readLock,
  reclaimIfStale,
  reclaimStaleClaim,
  sharedLockDir,
  writeLock,
} from "../src/process.js";

function withHome<T>(fn: (home: string) => T): T {
  const home = mkdtempSync(join(tmpdir(), "bb-oc-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return fn(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

describe("lock reclaim", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("treats a dead pid as stale (ISC-50.1)", () => {
    expect(isLockStale({ pid: 99999999, port: 1, startedAt: new Date().toISOString() })).toBe(
      true,
    );
  });

  it("removes a lock only when the port is not healthy", async () => {
    await withHome(async (home) => {
      const dir = join(home, "data");
      writeLock(dir, { pid: 99999999, port: 1, startedAt: new Date().toISOString() });
      expect(await reclaimIfStale(dir)).toBe(true);
      expect(readLock(dir)).toBeUndefined();

      writeLock(dir, { pid: 99999999, port: 4242, startedAt: new Date().toISOString() });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        return { ok: url.includes(":4242/") } as Response;
      }) as typeof fetch;
      expect(await reclaimIfStale(dir)).toBe(false);
      expect(readLock(dir)?.port).toBe(4242);
    });
  });

  it("reclaims a stale claim file so attach is not bricked", () => {
    withHome(() => {
      writeFileSync(
        claimPath(),
        `${JSON.stringify({ pid: 99999999, startedAt: "2000-01-01T00:00:00.000Z" })}\n`,
      );
      expect(reclaimStaleClaim()).toBe(true);
      expect(existsSync(claimPath())).toBe(false);
    });
  });

  it("refuses to spawn when attach-only and no healthy serve", async () => {
    await withHome(async (home) => {
      await expect(
        attachOrSpawn({ dataDir: join(home, "data"), spawn: false }),
      ).rejects.toThrow(/not attached/i);
    });
  });

  it("uses one host-wide lock path (ISC-50, ISC-62)", () => {
    expect(lockPath("/tmp/a")).toBe(lockPath("/tmp/b"));
    expect(lockPath("/tmp/a").startsWith(sharedLockDir())).toBe(true);
  });
});
