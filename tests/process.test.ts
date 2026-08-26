import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
import {
  attachOrSpawn,
  claimPath,
  isLockStale,
  lockPath,
  openCodeServeEnvironment,
  readLock,
  reclaimIfStale,
  reclaimStaleClaim,
  sharedLockDir,
  writeLock,
} from "../src/process.js";

async function withHome<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), "bb-oc-home-"));
  const previous = process.env.HOME;
  process.env.HOME = home;
  try {
    return await fn(home);
  } finally {
    if (previous === undefined) delete process.env.HOME;
    else process.env.HOME = previous;
  }
}

describe("OpenCode serve environment", () => {
  it("does not inherit Basic-auth settings the bridge cannot answer", () => {
    expect(
      openCodeServeEnvironment({
        HOME: "/tmp/home",
        OPENCODE_SERVER_USERNAME: "user",
        OPENCODE_SERVER_PASSWORD: "secret",
      }),
    ).toEqual({ HOME: "/tmp/home" });
  });
});

describe("lock reclaim", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    spawnMock.mockReset();
  });

  it("treats a dead pid as stale (ISC-50.1)", () => {
    expect(isLockStale({ pid: 99999999, port: 1, startedAt: new Date().toISOString() })).toBe(
      true,
    );
  });

  it("keeps a lock when health is slow instead of spawning another serve", async () => {
    await withHome(async (home) => {
      const dir = join(home, "data");
      writeLock(dir, { pid: process.pid, port: 4242, startedAt: new Date().toISOString() });
      globalThis.fetch = (async () => {
        const error = new Error("The operation was aborted due to timeout");
        error.name = "TimeoutError";
        throw error;
      }) as typeof fetch;
      expect(await reclaimIfStale(dir)).toBe(false);
      expect(readLock(dir)?.port).toBe(4242);
      spawnMock.mockClear();
      await expect(
        attachOrSpawn({ dataDir: dir, binary: "opencode" }),
      ).rejects.toThrow(/did not answer in time|Not spawning another/i);
      expect(spawnMock).not.toHaveBeenCalled();
    });
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

  it("keeps a fresh claim while its owner pid is alive", () => {
    withHome(() => {
      writeFileSync(
        claimPath(),
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      expect(reclaimStaleClaim()).toBe(false);
      expect(existsSync(claimPath())).toBe(true);
    });
  });

  it("reclaims a live-pid claim after the 5s TTL", () => {
    withHome(() => {
      writeFileSync(
        claimPath(),
        `${JSON.stringify({ pid: process.pid, startedAt: "2000-01-01T00:00:00.000Z" })}\n`,
      );
      expect(reclaimStaleClaim()).toBe(true);
      expect(existsSync(claimPath())).toBe(false);
    });
  });

  it("kills a spawned serve that exits during startup", async () => {
    const home = mkdtempSync(join(tmpdir(), "bb-oc-home-"));
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      const child = {
        pid: 12345,
        exitCode: 1,
        kill: vi.fn(),
        unref: vi.fn(),
        stderr: { on: vi.fn() },
        stdout: { on: vi.fn() },
      };
      spawnMock.mockReturnValue(child);
      globalThis.fetch = (async () => ({ ok: false })) as unknown as typeof fetch;

      await expect(
        attachOrSpawn({ dataDir: join(home, "data"), binary: "opencode" }),
      ).rejects.toThrow(/exited during startup|exited with/i);
      expect(child.kill).toHaveBeenCalledOnce();
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
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
