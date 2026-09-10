import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { handleReload } from "../src/host-handlers.js";
import { resetHoldForTests } from "../src/hold.js";
import { noteLiveTaskChild } from "../src/task-live.js";
import {
  attachOrSpawn,
  LAUNCH_FILE_NAME,
  LAUNCH_GUARD_FILE,
  LAUNCH_OWNER,
  LOCK_FILE_NAME,
  launchGuardBlockMessage,
  lockPath,
  persistLaunchClaim,
  pidAlive,
  processStartIdentity,
  readLaunchClaim,
  readLock,
  resetSpawnedServesForTests,
  setLaunchStopHoldHookForTests,
  setProcessStartIdentityForTests,
  sharedLockDir,
  spawnOwnership,
  stopServeIf,
  writeLock,
} from "../src/process.js";
import {
  readUpdateStatus,
  resetLatestCacheForTests,
} from "../src/update.js";

const originalHome = process.env.HOME;
const originalBin = process.env.OPENCODE_BIN;
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHoldForTests();
  resetLatestCacheForTests();
  resetSpawnedServesForTests();
  setLaunchStopHoldHookForTests();
  setProcessStartIdentityForTests();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalBin;
});

function withHome(): { home: string; dataDir: string } {
  const home = mkdtempSync(join(tmpdir(), "bb-oc-launch-"));
  process.env.HOME = home;
  delete process.env.OPENCODE_BIN;
  return { home, dataDir: join(home, "data") };
}

function launchFile(): string {
  return join(sharedLockDir(), LAUNCH_FILE_NAME);
}

function guardFile(): string {
  return join(sharedLockDir(), LAUNCH_GUARD_FILE);
}

function writeFakeBinary(home: string, version: string): string {
  const dir = join(home, ".opencode", "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "version"), `${version}\n`);
  const bin = join(dir, "opencode");
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const dir = path.dirname(process.argv[1]);
const versionFile = path.join(dir, "version");
const readVersion = () => fs.readFileSync(versionFile, "utf8").trim();
const startedVersion = readVersion();
if (process.argv[2] === "--version") {
  process.stdout.write(readVersion() + "\\n");
  process.exit(0);
}
if (process.argv[2] === "serve") {
  const portFlag = process.argv.indexOf("--port");
  const port = Number(process.argv[portFlag + 1]);
  http.createServer((req, res) => {
    if ((req.url || "").startsWith("/global/health")) {
      res.end(JSON.stringify({ healthy: true, version: startedVersion }));
      return;
    }
    if ((req.url || "").startsWith("/session/status")) {
      res.end("{}");
      return;
    }
    res.statusCode = 404;
    res.end();
  }).listen(port, "127.0.0.1");
  return;
}
process.exit(1);
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

async function liveNode(): Promise<{ pid: number; stop: () => void }> {
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    detached: true,
    stdio: "ignore",
  });
  const pid = child.pid!;
  child.unref();
  for (let i = 0; i < 40 && !pidAlive(pid); i += 1) {
    await delay(25);
  }
  return {
    pid,
    stop: () => {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    },
  };
}

describe("durable launch claim", () => {
  it("persists a private claim after spawn so a cleared module map still owns it", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      const claim = readLaunchClaim();
      expect(claim?.owner).toBe(LAUNCH_OWNER);
      expect(claim?.pid).toBe(attached.pid);
      expect(claim?.port).toBe(attached.port);
      expect(claim?.startedAt).toBe(attached.startedAt);
      expect(claim?.token).toMatch(/^[0-9a-f]{32}$/);
      expect(claim?.startIdentity).toBe(processStartIdentity(attached.pid));
      expect(statSync(launchFile()).mode & 0o777).toBe(0o600);
      resetSpawnedServesForTests();
      expect(
        spawnOwnership(
          attached.pid,
          attached.port,
          attached.startedAt ?? "",
          claim?.token,
        ).ok,
      ).toBe(true);
      const lock = readLock(dataDir)!;
      expect(await stopServeIf(dataDir, lock, claim!.token)).toBe("stopped");
      expect(pidAlive(attached.pid)).toBe(false);
      expect(readLaunchClaim()).toBeNull();
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });

  it("fails closed on corrupt, stale, pid-reuse, and startedAt mismatch claims", async () => {
    const { dataDir } = withHome();
    const live = await liveNode();
    try {
      const lock = {
        pid: live.pid,
        port: 4242,
        startedAt: new Date().toISOString(),
      };
      expect(persistLaunchClaim(lock)).toMatch(/^[0-9a-f]{32}$/);
      expect(spawnOwnership(lock.pid, lock.port, "other-start").ok).toBe(false);

      const claim = readLaunchClaim()!;
      writeFileSync(
        launchFile(),
        `${JSON.stringify({ ...claim, startIdentity: "ps:not-this-process" })}\n`,
      );
      expect(spawnOwnership(lock.pid, lock.port, lock.startedAt)).toEqual({
        ok: false,
        error: "OpenCode pid was reused; launch claim does not match",
      });

      writeFileSync(launchFile(), "{not json");
      expect(readLaunchClaim()).toBeNull();
      expect(spawnOwnership(lock.pid, lock.port, lock.startedAt).ok).toBe(false);

      expect(persistLaunchClaim(lock)).toMatch(/^[0-9a-f]{32}$/);
      live.stop();
      for (let i = 0; i < 40 && pidAlive(live.pid); i += 1) {
        await delay(25);
      }
      expect(spawnOwnership(lock.pid, lock.port, lock.startedAt).ok).toBe(false);
      writeLock(dataDir, lock);
      expect(await stopServeIf(dataDir, lock, "ab".repeat(16))).toBe("unowned");
      expect(readLock(dataDir)?.pid).toBe(live.pid);
    } finally {
      live.stop();
    }
  });

  it("does not clobber a replacement lock or claim", async () => {
    const { dataDir } = withHome();
    const original = await liveNode();
    const replacement = await liveNode();
    try {
      const first = {
        pid: original.pid,
        port: 1,
        startedAt: "2020-01-01T00:00:00.000Z",
      };
      const second = {
        pid: replacement.pid,
        port: 2,
        startedAt: "2021-01-01T00:00:00.000Z",
      };
      const firstToken = persistLaunchClaim(first);
      expect(firstToken).toMatch(/^[0-9a-f]{32}$/);
      writeLock(dataDir, first);
      const secondToken = persistLaunchClaim(second);
      expect(secondToken).toMatch(/^[0-9a-f]{32}$/);
      writeLock(dataDir, second);
      expect(await stopServeIf(dataDir, first, firstToken!)).toBe("unowned");
      expect(readLock(dataDir)?.pid).toBe(replacement.pid);
      expect(readLaunchClaim()?.pid).toBe(replacement.pid);
      expect(pidAlive(original.pid)).toBe(true);
      expect(pidAlive(replacement.pid)).toBe(true);
    } finally {
      original.stop();
      replacement.stop();
    }
  });

  it("does not clobber a claim replaced while stop holds the guard", async () => {
    const { dataDir } = withHome();
    const original = await liveNode();
    const replacement = await liveNode();
    try {
      const first = {
        pid: original.pid,
        port: 1,
        startedAt: "2020-01-01T00:00:00.000Z",
      };
      const second = {
        pid: replacement.pid,
        port: 2,
        startedAt: "2021-01-01T00:00:00.000Z",
      };
      const firstToken = persistLaunchClaim(first);
      expect(firstToken).toMatch(/^[0-9a-f]{32}$/);
      writeLock(dataDir, first);
      const replacementToken = "ab".repeat(16);
      setLaunchStopHoldHookForTests(() => {
        expect(persistLaunchClaim(second)).toBeNull();
        const identity = processStartIdentity(replacement.pid);
        expect(identity).toBeTruthy();
        writeFileSync(
          launchFile(),
          `${JSON.stringify({
            owner: LAUNCH_OWNER,
            pid: second.pid,
            port: second.port,
            startedAt: second.startedAt,
            token: replacementToken,
            startIdentity: identity,
          })}\n`,
        );
        writeLock(dataDir, second);
      });
      const signaled: number[] = [];
      const originalKill = process.kill.bind(process);
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal && signal !== 0) signaled.push(pid);
        return originalKill(pid, signal);
      }) as typeof process.kill;
      try {
        const stop = await stopServeIf(dataDir, first, firstToken!);
        expect(["replaced", "stopped"]).toContain(stop);
      } finally {
        process.kill = originalKill;
      }
      expect(readLaunchClaim()?.token).toBe(replacementToken);
      expect(readLock(dataDir)?.pid).toBe(replacement.pid);
      expect(pidAlive(replacement.pid)).toBe(true);
      expect(signaled).not.toContain(replacement.pid);
      expect(signaled).not.toContain(-replacement.pid);
    } finally {
      setLaunchStopHoldHookForTests();
      original.stop();
      replacement.stop();
    }
  });

  it("refuses owned stop without the exact token and does not signal", async () => {
    const { dataDir } = withHome();
    const live = await liveNode();
    try {
      const lock = {
        pid: live.pid,
        port: 9,
        startedAt: new Date().toISOString(),
      };
      const token = persistLaunchClaim(lock);
      writeLock(dataDir, lock);
      const signaled: number[] = [];
      const originalKill = process.kill.bind(process);
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal && signal !== 0) signaled.push(pid);
        return originalKill(pid, signal);
      }) as typeof process.kill;
      try {
        expect(await stopServeIf(dataDir, lock, "")).toBe("unowned");
        expect(await stopServeIf(dataDir, lock, "cd".repeat(16))).toBe(
          "unowned",
        );
        expect(
          spawnOwnership(lock.pid, lock.port, lock.startedAt, "cd".repeat(16))
            .ok,
        ).toBe(false);
      } finally {
        process.kill = originalKill;
      }
      expect(signaled).toEqual([]);
      expect(pidAlive(live.pid)).toBe(true);
      expect(readLaunchClaim()?.token).toBe(token);
      expect(existsSync(guardFile())).toBe(false);
    } finally {
      live.stop();
    }
  });

  it("never auto-reclaims a stale guard and preserves a foreign token", async () => {
    const { home, dataDir } = withHome();
    const live = await liveNode();
    try {
      const lock = {
        pid: live.pid,
        port: 9,
        startedAt: new Date().toISOString(),
      };
      const token = persistLaunchClaim(lock);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(existsSync(guardFile())).toBe(false);
      writeLock(dataDir, lock);
      mkdirSync(sharedLockDir(), { recursive: true });
      const stale = "dead-holder-not-reclaimed\n";
      writeFileSync(guardFile(), stale);
      expect(persistLaunchClaim(lock)).toBeNull();
      expect(readFileSync(guardFile(), "utf8")).toBe(stale);
      const signaled: number[] = [];
      const originalKill = process.kill.bind(process);
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal && signal !== 0) signaled.push(pid);
        return originalKill(pid, signal);
      }) as typeof process.kill;
      try {
        expect(
          await stopServeIf(dataDir, lock, token!),
        ).toBe("unowned");
      } finally {
        process.kill = originalKill;
      }
      expect(signaled).toEqual([]);
      expect(pidAlive(live.pid)).toBe(true);
      expect(readFileSync(guardFile(), "utf8")).toBe(stale);
      expect(readLaunchClaim()?.token).toBe(token);
      const blocked = launchGuardBlockMessage();
      expect(blocked).toMatch(/opencode\.launch\.guard/);
      expect(blocked).toMatch(/ownership operation or updater/);
      expect(blocked).not.toContain(home);
    } finally {
      live.stop();
    }
  });

  it("makes restart unavailable when the launch claim is missing", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("api.github.com")) {
        return new Response(JSON.stringify({ tag_name: "v1.18.29" }), {
          status: 200,
        });
      }
      return originalFetch(input);
    }) as typeof fetch;
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.29\n");
      unlinkSync(launchFile());
      resetSpawnedServesForTests();
      const status = await readUpdateStatus(dataDir);
      expect(status.canRestart).toBe(false);
      expect(status.error).toMatch(/BB-launched serve|ownership cannot be proven/i);
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });
});

describe("handleReload", () => {
  it("stops a disposable owned serve", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      resetSpawnedServesForTests();
      const result = await handleReload(dataDir);
      expect(result).toEqual({ ok: true, error: null });
      expect(pidAlive(attached.pid)).toBe(false);
      expect(readLaunchClaim()).toBeNull();
      expect(readLock(dataDir)).toBeUndefined();
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });

  it("refuses reload while sessions are busy and does not signal", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const unrelatedPid = unrelated.pid!;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/session/status")) {
          return new Response(JSON.stringify({ ses_busy: { type: "busy" } }), {
            status: 200,
          });
        }
        return originalFetch(input);
      }) as typeof fetch;
      const result = await handleReload(dataDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/busy/i);
      expect(pidAlive(attached.pid)).toBe(true);
      expect(pidAlive(unrelatedPid)).toBe(true);
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
      try {
        process.kill(unrelatedPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("refuses reload while a live task child is running and does not signal", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      noteLiveTaskChild({
        parentSessionId: "ses_parent",
        childSessionId: "ses_child",
        running: true,
      });
      const result = await handleReload(dataDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/busy/i);
      expect(pidAlive(attached.pid)).toBe(true);
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });

  it("fails closed on guard, missing claim, corrupt claim, and foreign ownership without signaling", async () => {
    const { dataDir } = withHome();
    const live = await liveNode();
    try {
      const lock = {
        pid: live.pid,
        port: 9,
        startedAt: new Date().toISOString(),
      };
      const token = persistLaunchClaim(lock);
      writeLock(dataDir, lock);
      mkdirSync(sharedLockDir(), { recursive: true });
      const stale = "stale-reload-guard\n";
      writeFileSync(guardFile(), stale);
      const signaled: number[] = [];
      const originalKill = process.kill.bind(process);
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal && signal !== 0) signaled.push(pid);
        return originalKill(pid, signal);
      }) as typeof process.kill;
      try {
        const guarded = await handleReload(dataDir);
        expect(guarded.ok).toBe(false);
        expect(guarded.error).toMatch(/opencode\.launch\.guard/);
        expect(readFileSync(guardFile(), "utf8")).toBe(stale);
        unlinkSync(guardFile());

        unlinkSync(launchFile());
        const missing = await handleReload(dataDir);
        expect(missing.ok).toBe(false);
        expect(missing.error).toMatch(/BB-launched serve|not a BB-launched/i);
        persistLaunchClaim(lock);
        writeFileSync(launchFile(), "{not json");
        const corrupt = await handleReload(dataDir);
        expect(corrupt.ok).toBe(false);
        persistLaunchClaim(lock);
        const claim = readLaunchClaim()!;
        writeFileSync(
          launchFile(),
          `${JSON.stringify({ ...claim, token: "not-a-token" })}\n`,
        );
        const wrong = await handleReload(dataDir);
        expect(wrong.ok).toBe(false);
      } finally {
        process.kill = originalKill;
      }
      expect(signaled).toEqual([]);
      expect(pidAlive(live.pid)).toBe(true);
      expect(readLock(dataDir)?.pid).toBe(live.pid);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      live.stop();
    }
  });

  it("preserves a replacement lock and claim during reload", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    const replacement = await liveNode();
    try {
      const second = {
        pid: replacement.pid,
        port: 2,
        startedAt: "2021-01-01T00:00:00.000Z",
      };
      const replacementToken = "cd".repeat(16);
      setLaunchStopHoldHookForTests(() => {
        const identity = processStartIdentity(replacement.pid);
        expect(identity).toBeTruthy();
        writeFileSync(
          launchFile(),
          `${JSON.stringify({
            owner: LAUNCH_OWNER,
            pid: second.pid,
            port: second.port,
            startedAt: second.startedAt,
            token: replacementToken,
            startIdentity: identity,
          })}\n`,
        );
        writeLock(dataDir, second);
      });
      const result = await handleReload(dataDir);
      expect(result.ok).toBe(false);
      expect(readLock(dataDir)?.pid).toBe(replacement.pid);
      expect(readLaunchClaim()?.token).toBe(replacementToken);
      expect(pidAlive(replacement.pid)).toBe(true);
    } finally {
      setLaunchStopHoldHookForTests();
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
      replacement.stop();
    }
  });
});

describe("attachOrSpawn claim publication", () => {
  it("does not publish lock or claim when the launch guard is stuck", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mkdirSync(sharedLockDir(), { recursive: true });
    writeFileSync(guardFile(), "stale-spawn-guard\n");
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      /launch guard is stuck|ownership cannot be proven/,
    );
    expect(readLock(dataDir)).toBeUndefined();
    expect(readLaunchClaim()).toBeNull();
    expect(readFileSync(guardFile(), "utf8")).toBe("stale-spawn-guard\n");
  });

  it("does not publish lock or claim when start identity is missing", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    setProcessStartIdentityForTests(null);
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      /ownership cannot be proven/,
    );
    expect(readLock(dataDir)).toBeUndefined();
    expect(readLaunchClaim()).toBeNull();
  });

  it("removes the exact claim and does not leave a lock when lock write fails", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mkdirSync(lockPath(dataDir), { recursive: true });
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      /lock could not be published/,
    );
    expect(readLaunchClaim()).toBeNull();
    expect(existsSync(join(sharedLockDir(), LOCK_FILE_NAME))).toBe(true);
    expect(readLock(dataDir)).toBeUndefined();
    rmdirSync(lockPath(dataDir));
  });
});

describe("cross-process launch ownership", () => {
  it("stops from a cleared module map using the production claim token", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const unrelatedPid = unrelated.pid!;
    try {
      resetSpawnedServesForTests();
      const token = readLaunchClaim()?.token;
      const lock = readLock(dataDir);
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      expect(lock).toBeTruthy();
      expect(await stopServeIf(dataDir, lock!, "")).toBe("unowned");
      expect(await stopServeIf(dataDir, lock!, "ef".repeat(16))).toBe("unowned");
      expect(pidAlive(attached.pid)).toBe(true);
      expect(await stopServeIf(dataDir, lock!, token!)).toBe("stopped");
      expect(pidAlive(attached.pid)).toBe(false);
      expect(pidAlive(unrelatedPid)).toBe(true);
      expect(readLaunchClaim()).toBeNull();
      expect(readLock(dataDir)).toBeUndefined();
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
      try {
        process.kill(unrelatedPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("does not let two processes reclaim or mutate through a stale launch guard", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      const token = readLaunchClaim()?.token;
      expect(token).toMatch(/^[0-9a-f]{32}$/);
      const claimBefore = readFileSync(launchFile(), "utf8");
      mkdirSync(sharedLockDir(), { recursive: true });
      const stale = "999999001\n";
      writeFileSync(guardFile(), stale);
      const script = `const fs=require("node:fs");try{fs.writeFileSync(process.argv[1],"stolen",{flag:"wx"});process.exit(2)}catch{process.exit(1)}`;
      const first = spawn(process.execPath, ["-e", script, guardFile()], {
        stdio: "ignore",
      });
      const second = spawn(process.execPath, ["-e", script, guardFile()], {
        stdio: "ignore",
      });
      const wait = (child: ReturnType<typeof spawn>) =>
        new Promise<number | null>((resolve) => {
          child.on("close", (code) => resolve(code));
        });
      const [a, b] = await Promise.all([wait(first), wait(second)]);
      expect(a).not.toBe(0);
      expect(b).not.toBe(0);
      expect(readFileSync(guardFile(), "utf8")).toBe(stale);
      expect(await stopServeIf(dataDir, readLock(dataDir)!, token!)).toBe(
        "unowned",
      );
      expect(readFileSync(launchFile(), "utf8")).toBe(claimBefore);
      expect(pidAlive(attached.pid)).toBe(true);
      expect(launchGuardBlockMessage()).toMatch(/opencode\.launch\.guard/);
      expect(launchGuardBlockMessage()).not.toContain(home);
    } finally {
      try {
        process.kill(-attached.pid, "SIGKILL");
      } catch {
        try {
          process.kill(attached.pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });
});
