import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});
import {
  attachOrSpawn,
  claimPath,
  isLockStale,
  lockPath,
  openCodeServeEnvironment,
  readLock,
  reclaimIfStale,
  reclaimStaleClaim,
  removeSpawnClaimIfOwned,
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
        `${JSON.stringify({ pid: 99999999, token: "ab".repeat(16) })}\n`,
      );
      expect(reclaimStaleClaim()).toBe(true);
      expect(existsSync(claimPath())).toBe(false);
    });
  });

  it("does not delete a successor spawn claim when removing an old token", () => {
    withHome(() => {
      const oldToken = "aa".repeat(16);
      const newToken = "bb".repeat(16);
      writeFileSync(
        claimPath(),
        `${JSON.stringify({ pid: process.pid, token: newToken })}\n`,
      );
      removeSpawnClaimIfOwned(oldToken);
      expect(JSON.parse(readFileSync(claimPath(), "utf8")).token).toBe(newToken);
    });
  });

  it("keeps a live owner claim regardless of elapsed time", () => {
    withHome(() => {
      writeFileSync(
        claimPath(),
        `${JSON.stringify({
          pid: process.pid,
          token: "cd".repeat(16),
          startedAt: "2000-01-01T00:00:00.000Z",
        })}\n`,
      );
      expect(reclaimStaleClaim()).toBe(false);
      expect(existsSync(claimPath())).toBe(true);
    });
  });

  it("does not let a second spawn steal a live claim older than 5s", { timeout: 15_000 }, async () => {
    await withHome(async (home) => {
      const token = "ef".repeat(16);
      writeFileSync(
        claimPath(),
        `${JSON.stringify({
          pid: process.pid,
          token,
          startedAt: "2000-01-01T00:00:00.000Z",
        })}\n`,
      );
      const { spawn: realSpawn } = await vi.importActual<
        typeof import("node:child_process")
      >("node:child_process");
      const thief = realSpawn(
        process.execPath,
        [
          "-e",
          `const fs=require("node:fs");const p=process.argv[1];try{fs.writeFileSync(p,"stolen",{flag:"wx"});process.exit(2)}catch{process.exit(0)}`,
          claimPath(),
        ],
        { stdio: "ignore" },
      );
      await new Promise<void>((resolve, reject) => {
        thief.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`thief exited ${code}`));
        });
      });
      await expect(
        attachOrSpawn({ dataDir: join(home, "data"), spawn: true }),
      ).rejects.toThrow(/Timed out waiting for the other worker/i);
      expect(JSON.parse(readFileSync(claimPath(), "utf8")).token).toBe(token);
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
      const kill = vi.spyOn(process, "kill");
      try {
        await expect(
          attachOrSpawn({ dataDir: join(home, "data"), binary: "opencode" }),
        ).rejects.toThrow(/exited during startup|exited with/i);
        expect(
          kill.mock.calls.some(
            ([pid, signal]) =>
              (pid === 12345 || pid === -12345) &&
              signal !== undefined &&
              signal !== 0,
          ),
        ).toBe(true);
      } finally {
        kill.mockRestore();
      }
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
