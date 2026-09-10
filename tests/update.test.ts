import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { handleLine, resetBridgeForTests } from "../src/bridge.js";
import { handleReload } from "../src/host-handlers.js";
import {
  acquireExclusive,
  acquireStartGuard,
  adoptExclusive,
  exclusiveKind,
  exclusiveToken,
  HOLD_FILE_NAME,
  holdBlockMessage,
  inspectHold,
  processGroupAlive,
  releaseExclusive,
  releaseStartGuard,
  resetHoldForTests,
} from "../src/hold.js";
import {
  attachOrSpawn,
  canonicalPath,
  ownsSpawnedServe,
  pidAlive,
  readLock,
  resetSpawnedServesForTests,
  writeLock,
} from "../src/process.js";
import { noteLiveTaskChild } from "../src/task-live.js";
import {
  ageLatestCacheForTests,
  detectUpgradeMethod,
  exactPostInstall,
  fetchLatestSupported,
  forwardGroupSignals,
  hostWrapEntry,
  LATEST_FAIL_CACHE_MS,
  pickHighestEligibleRelease,
  planInstall,
  providerInstallationRun,
  providerInstallationStatus,
  readCliVersion,
  readUpdateStatus,
  resetLatestCacheForTests,
  restartToApply,
  runInstallWrap,
  selectEnrolledHost,
  setPlatformForTests,
  summarizeInstallEvents,
} from "../src/update.js";

const originalFetch = globalThis.fetch;
const originalHome = process.env.HOME;
const originalBin = process.env.OPENCODE_BIN;
const originalLive = process.env.OC_TASK_LIVE_PATH;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetHoldForTests();
  resetLatestCacheForTests();
  resetSpawnedServesForTests();
  setPlatformForTests();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalBin === undefined) delete process.env.OPENCODE_BIN;
  else process.env.OPENCODE_BIN = originalBin;
  if (originalLive === undefined) delete process.env.OC_TASK_LIVE_PATH;
  else process.env.OC_TASK_LIVE_PATH = originalLive;
});

function withHome(): { home: string; dataDir: string } {
  const home = mkdtempSync(join(tmpdir(), "bb-oc-update-"));
  process.env.HOME = home;
  delete process.env.OPENCODE_BIN;
  process.env.OC_TASK_LIVE_PATH = join(home, "task-live.json");
  return { home, dataDir: join(home, "data") };
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
if (process.argv[2] === "upgrade") {
  fs.writeFileSync(versionFile, process.argv[3] + "\\n");
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

function mockGithubPages(
  pages: Array<Array<{ tag: string; prerelease?: boolean }>>,
): { calls: string[] } {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.includes("api.github.com/repos/anomalyco/opencode/releases")) {
      const item = pages[0]?.[0];
      return new Response(
        JSON.stringify(item ? {
          tag_name: item.tag,
          prerelease: item.prerelease === true,
        } : {}),
        { status: 200 },
      );
    }
    return originalFetch(input);
  }) as typeof fetch;
  return { calls };
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("port"));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on("error", reject);
  });
}

describe("selectEnrolledHost", () => {
  it("requires the unique connected host or an explicit connected hostId", () => {
    expect(selectEnrolledHost([])).toMatchObject({ ok: false });
    expect(
      selectEnrolledHost([
        { id: "a", status: "connected" },
        { id: "b", status: "connected" },
      ]),
    ).toMatchObject({ ok: false, error: expect.stringMatching(/hostId/) });
    expect(
      selectEnrolledHost([{ id: "b", status: "connected" }]),
    ).toEqual({ ok: true, hostId: "b" });
  });
});

describe("planInstall identity", () => {
  it("fails closed when realpath cannot be resolved and rejects symlink retargeting", () => {
    const { home } = withHome();
    const real = writeFakeBinary(home, "1.18.21");
    expect(
      planInstall({
        binaryPath: join(home, "missing"),
        resolvedPath: join(home, "missing"),
        diskVersion: "1.18.21",
        targetVersion: "1.18.29",
        method: "curl",
      }).ok,
    ).toBe(false);
    const decoyDir = join(home, "other");
    mkdirSync(decoyDir, { recursive: true });
    const decoy = join(decoyDir, "opencode");
    writeFileSync(decoy, "#!/bin/sh\nexit 0\n");
    chmodSync(decoy, 0o755);
    const link = join(home, "link-opencode");
    symlinkSync(real, link);
    expect(canonicalPath(link)).toBe(canonicalPath(real));
    expect(
      planInstall({
        binaryPath: link,
        resolvedPath: decoy,
        diskVersion: "1.18.21",
        targetVersion: "1.18.29",
        method: "curl",
      }).ok,
    ).toBe(false);
    unlinkSync(link);
    symlinkSync(decoy, link);
    expect(
      planInstall({
        binaryPath: link,
        resolvedPath: real,
        diskVersion: "1.18.21",
        targetVersion: "1.18.29",
        method: "curl",
      }).ok,
    ).toBe(false);
    expect(detectUpgradeMethod(real, home)).toBe("curl");
    expect(detectUpgradeMethod(decoy, home)).toBe("unknown");
  });
});

describe("release selection", () => {
  it("picks the highest strict in-window release and ignores junk", () => {
    expect(
      pickHighestEligibleRelease([
        { tag_name: "v1.19.0", prerelease: false },
        { tag_name: "v1.18.21foo", prerelease: false },
        { tag_name: "v1.18.29", prerelease: false },
      ]),
    ).toBe("1.18.29");
  });

  it("fetches GitHub's latest release and caches success and failures briefly", async () => {
    const { calls } = mockGithubPages([[{ tag: "v1.18.29" }]]);
    expect(await fetchLatestSupported()).toBe("1.18.29");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("/releases/latest");
    const after = calls.length;
    expect(await fetchLatestSupported()).toBe("1.18.29");
    expect(calls.length).toBe(after);
    resetLatestCacheForTests();
    let fails = 0;
    globalThis.fetch = (async () => {
      fails += 1;
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    expect(await fetchLatestSupported()).toBeNull();
    expect(await fetchLatestSupported()).toBeNull();
    expect(fails).toBe(1);
    ageLatestCacheForTests(LATEST_FAIL_CACHE_MS + 1);
    expect(await fetchLatestSupported()).toBeNull();
    expect(fails).toBe(2);
  });

  it("treats a failed latest-release request as unknown and never current", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("api.github.com")) return originalFetch(input);
      return new Response("nope", { status: 500 });
    }) as typeof fetch;
    expect(await fetchLatestSupported()).toBeNull();
    const status = await readUpdateStatus(dataDir);
    expect(status.latestVersion).toBeNull();
    expect(status.current).toBe(false);
  });
});

describe("provider installation contract", () => {
  it("returns a guarded update plan only when target > disk on the canonical binary", async () => {
    const { home } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const status = await providerInstallationStatus();
    expect(status.needsUpdate).toBe(false);
    expect(status.installAction).toBeNull();
    const run = await providerInstallationRun("update");
    const wrap = hostWrapEntry();
    if (!wrap) {
      expect(run).toMatchObject({
        available: false,
        message: expect.stringMatching(/not built/),
      });
    } else if (run.available) {
      expect(run.command.command).toBe(process.execPath);
      expect(run.command.args[0]).toBe(wrap);
      expect(run.command.args.slice(1, 3)).toEqual([
        "--oc-install-wrap",
        canonicalPath(join(home, ".opencode", "bin", "opencode")),
      ]);
      expect(run.command.args.slice(-4)).toEqual([
        "upgrade",
        "1.18.29",
        "--method",
        "curl",
      ]);
      expect(exclusiveKind()).toBeNull();
    } else {
      expect.fail("expected an available update plan");
    }
    expect((await providerInstallationRun("install")).available).toBe(false);
  });

  it("offers an update while a normal thread start guard is active", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const token = acquireStartGuard();
    expect(token).toBeTruthy();
    expect(await readUpdateStatus(dataDir)).toMatchObject({
      eligible: true,
      targetVersion: "1.18.29",
      error: "Running OpenCode version is unknown",
    });
    releaseStartGuard(token!);
  });

  it("wrapper acquires hold before mutation and loses to restart", async () => {
    const { home } = withHome();
    const bin = writeFakeBinary(home, "1.18.21");
    const restartToken = acquireExclusive("restart");
    expect(restartToken).toBeTruthy();
    expect(
      await runInstallWrap([bin, "upgrade", "1.18.29", "--method", "curl"]),
    ).toBe(1);
    expect(readCliVersion(bin)).toBe("1.18.21");
    releaseExclusive(restartToken!);
    expect(await runInstallWrap([bin, "upgrade", "1.18.29", "--method", "curl"])).toBe(
      0,
    );
    expect(readCliVersion(bin)).toBe("1.18.29");
    expect(exclusiveKind()).toBeNull();
  });

  it("refuses a stale target after a racing disk advance", async () => {
    const { home } = withHome();
    const bin = writeFakeBinary(home, "1.18.29");
    expect(
      await runInstallWrap([bin, "upgrade", "1.18.29", "--method", "curl"]),
    ).toBe(1);
    expect(readCliVersion(bin)).toBe("1.18.29");
  });

  it("does not release another hold token from a failed restart", async () => {
    const { dataDir } = withHome();
    const installToken = acquireExclusive("install", "1.18.29");
    expect(installToken).toBeTruthy();
    expect(await restartToApply(dataDir)).toMatchObject({ ok: false });
    expect(exclusiveKind()).toBe("install");
    expect(exclusiveToken()).toBe(installToken);
    releaseExclusive(installToken!);
  });

  it("does not start the CLI when hold adoption fails", async () => {
    const { home } = withHome();
    const bin = writeFakeBinary(home, "1.18.21");
    expect(
      await runInstallWrap([bin, "upgrade", "1.18.29", "--method", "curl"], {
        adopt: () => false,
      }),
    ).toBe(1);
    expect(readCliVersion(bin)).toBe("1.18.21");
    expect(existsSync(join(home, ".opencode", "bin", "argv"))).toBe(false);
  });

  it("hides install on Windows and reports an unsupported message", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    setPlatformForTests("win32");
    const status = await readUpdateStatus(dataDir);
    expect(status.eligible).toBe(false);
    expect(status.error).toMatch(/Windows/);
    const provider = await providerInstallationStatus();
    expect(provider.needsUpdate).toBe(false);
    expect(provider.installAction).toBeNull();
    const run = await providerInstallationRun("update");
    expect(run.available).toBe(false);
    if (!run.available) expect(run.message).toMatch(/Windows/);
  });

  it("reports stuck pending hold without auto-clearing it", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const dir = join(home, ".bb", "plugins", "opencode");
    mkdirSync(dir, { recursive: true });
    const stuck = `${JSON.stringify({
      exclusive: {
        token: "stuck",
        pid: 999999001,
        kind: "install",
        phase: "pending",
      },
      starts: {},
    })}\n`;
    writeFileSync(join(dir, HOLD_FILE_NAME), stuck);
    expect(inspectHold()).toEqual({
      status: "ambiguous",
      reason: "pending-dead",
    });
    const blocked = holdBlockMessage();
    expect(blocked).toMatch(/opencode\.hold\.json/);
    expect(blocked).toMatch(/process group/);
    expect(blocked).not.toContain(home);
    const status = await readUpdateStatus(dataDir);
    expect(status.eligible).toBe(false);
    expect(status.canRestart).toBe(false);
    expect(status.error).toBe(blocked);
    const provider = await providerInstallationStatus();
    expect(provider.needsUpdate).toBe(false);
    expect(provider.installAction).toBeNull();
    const run = await providerInstallationRun("update");
    expect(run.available).toBe(false);
    if (!run.available) expect(run.message).toBe(blocked);
    expect(await restartToApply(dataDir)).toMatchObject({
      ok: false,
      error: blocked,
    });
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      blocked ?? undefined,
    );
    expect(acquireExclusive("restart")).toBeNull();
    expect(readFileSync(join(dir, HOLD_FILE_NAME), "utf8")).toBe(stuck);
  });

  it("fails closed on malformed hold state", async () => {
    const { home, dataDir } = withHome();
    const dir = join(home, ".bb", "plugins", "opencode");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, HOLD_FILE_NAME), "{not json");
    expect(inspectHold()).toEqual({ status: "ambiguous", reason: "corrupt" });
    const blocked = holdBlockMessage();
    expect(blocked).toMatch(/opencode\.hold\.json/);
    expect(blocked).not.toContain(home);
    expect(acquireExclusive("install", "1.18.29")).toBeNull();
    expect(acquireStartGuard()).toBeNull();
    expect((await readUpdateStatus(dataDir)).error).toBe(blocked);
    const run = await providerInstallationRun("update");
    expect(run.available).toBe(false);
    if (!run.available) expect(run.message).toBe(blocked);
    expect(await restartToApply(dataDir)).toMatchObject({
      ok: false,
      error: blocked,
    });
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      blocked ?? undefined,
    );
    expect(readFileSync(join(dir, HOLD_FILE_NAME), "utf8")).toBe("{not json");
  });

  it("requires exact disk target after daemon events, not version_at_least", () => {
    const { home } = withHome();
    const path = writeFakeBinary(home, "1.18.28");
    expect(
      exactPostInstall({
        events: [{ type: "completed", success: true, exitCode: 0 }],
        expectedPath: path,
        expectedTarget: "1.18.29",
        after: {
          binaryPath: path,
          diskVersion: "1.18.28",
          runningVersion: null,
          latestVersion: "1.18.29",
          targetVersion: "1.18.29",
          method: "curl",
          eligible: false,
          canRestart: false,
          current: false,
          error: null,
        },
      }).ok,
    ).toBe(false);
    expect(
      exactPostInstall({
        events: [{ type: "completed", success: true, exitCode: 0 }],
        expectedPath: "/remote-host/bin/opencode",
        expectedTarget: "1.18.29",
        after: {
          binaryPath: "/remote-host/bin/opencode",
          diskVersion: "1.18.29",
          runningVersion: "1.18.28",
          latestVersion: "1.18.29",
          targetVersion: "1.18.29",
          method: "curl",
          eligible: false,
          canRestart: false,
          current: false,
          error: null,
        },
      }).ok,
    ).toBe(true);
  });

  it("summarizes daemon install events without claiming extra behavior", () => {
    expect(
      summarizeInstallEvents([
        { type: "started" },
        { type: "completed", success: true, exitCode: 0 },
      ]),
    ).toEqual({ ok: true, error: null });
    expect(
      summarizeInstallEvents([{ type: "error", message: "boom" }]),
    ).toEqual({ ok: false, error: "boom" });
    expect(
      summarizeInstallEvents([{ type: "completed", success: false, exitCode: 2 }]),
    ).toMatchObject({ ok: false });
  });
});

describe("bridge installation wiring", () => {
  it("answers provider/installation/status and run", async () => {
    const { home } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const messages: Array<Record<string, unknown>> = [];
    resetBridgeForTests({
      acquire: () => {
        throw new Error("no client");
      },
      attach: async () => ({ url: "http://127.0.0.1:9", pid: 1, port: 9 }),
      write: (message) => {
        messages.push(message);
      },
    });
    handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: "st", method: "provider/installation/status" }),
    );
    await delay(50);
    const status = messages.find((row) => row.id === "st") as {
      result?: { needsUpdate?: boolean };
    };
    expect(status?.result?.needsUpdate).toBe(false);
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "run",
        method: "provider/installation/run",
        params: { action: "update", providerId: "opencode" },
      }),
    );
    await delay(50);
    const run = messages.find((row) => row.id === "run") as {
      result?: { available?: boolean; command?: { args?: string[] } };
    };
    expect(run?.result?.available).toBe(true);
    expect(run?.result?.command?.args?.slice(-4)).toEqual([
      "upgrade",
      "1.18.29",
      "--method",
      "curl",
    ]);
  });
});

describe("readUpdateStatus", () => {
  it("is not current when disk matches latest but nothing healthy is running", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.21" }]]);
    const status = await readUpdateStatus(dataDir);
    expect(status.eligible).toBe(false);
    expect(status.current).toBe(false);
  });

  it("is current when healthy disk is ahead of latest and running matches disk", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.28");
    mockGithubPages([[{ tag: "v1.18.21" }]]);
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      const status = await readUpdateStatus(dataDir);
      expect(status.diskVersion).toBe("1.18.28");
      expect(status.latestVersion).toBe("1.18.21");
      expect(status.runningVersion).toBe("1.18.28");
      expect(status.current).toBe(true);
      expect(status.eligible).toBe(false);
      expect(status.canRestart).toBe(false);
      const provider = await providerInstallationStatus();
      expect(provider.needsUpdate).toBe(false);
      expect(provider.installAction).toBeNull();
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

  it("never treats an unsupported disk/running version as current", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.19.0");
    mockGithubPages([[{ tag: "v1.18.21" }]]);
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    try {
      const status = await readUpdateStatus(dataDir);
      expect(status.diskVersion).toBe("1.19.0");
      expect(status.runningVersion).toBe("1.19.0");
      expect(status.current).toBe(false);
      expect(status.eligible).toBe(false);
      expect(status.error).toMatch(/outside the pinned window/i);
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

describe("restart exclusion", () => {
  it("blocks attach/spawn, reload, and bridge turns while exclusive hold is active", async () => {
    const { dataDir } = withHome();
    const installToken = acquireExclusive("install", "1.18.29");
    expect(installToken).toBeTruthy();
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      /already in progress/,
    );
    expect(await handleReload(dataDir)).toMatchObject({
      ok: false,
      error: expect.stringMatching(/already in progress/),
    });
    const messages: Array<Record<string, unknown>> = [];
    resetBridgeForTests({
      acquire: () => {
        throw new Error("no client");
      },
      attach: async () => ({ url: "http://127.0.0.1:9", pid: 1, port: 9 }),
      write: (message) => {
        messages.push(message);
      },
    });
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "t",
        method: "thread/start",
        params: {
          threadId: "thr_1",
          cwd: "/tmp/a",
          instructionMode: "append",
          options: { permissionMode: "full" },
        },
      }),
    );
    await delay(20);
    expect(JSON.stringify(messages)).toMatch(/already in progress/);
    const steer = JSON.stringify(messages);
    handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "steer",
        method: "turn/steer",
        params: {
          threadId: "thr_1",
          expectedTurnId: "turn_1",
          input: [{ type: "text", text: "x", mentions: [] }],
        },
      }),
    );
    await delay(20);
    expect(JSON.stringify(messages)).toMatch(/already in progress|Unknown thread/);
    void steer;
    releaseExclusive(installToken!);
  });

  it("does not age-expire a live owner and reclaims a dead owner", () => {
    const { home } = withHome();
    expect(acquireExclusive("install", "1.18.29")).toBeTruthy();
    expect(exclusiveKind()).toBe("install");
    const dir = join(home, ".bb", "plugins", "opencode");
    writeFileSync(
      join(dir, "opencode.hold.json"),
      `${JSON.stringify({ exclusive: { token: "dead", pid: 999999001, kind: "install" }, starts: {} })}\n`,
    );
    expect(exclusiveKind()).toBeNull();
    const restartToken = acquireExclusive("restart");
    expect(restartToken).toBeTruthy();
    releaseExclusive(restartToken!);
  });

  it("lets an admitted start block exclusive restart until released", async () => {
    const { dataDir } = withHome();
    const token = acquireStartGuard();
    expect(token).toBeTruthy();
    expect(acquireExclusive("restart")).toBeNull();
    expect(await restartToApply(dataDir)).toMatchObject({ ok: false });
    await expect(attachOrSpawn({ dataDir, spawn: false })).rejects.toThrow(
      /not attached/,
    );
    releaseStartGuard(token!);
    const restartToken = acquireExclusive("restart");
    expect(restartToken).toBeTruthy();
    releaseExclusive(restartToken!);
  });
});

describe("restartToApply", () => {
  it("refuses unknown ownership and preserves unrelated processes", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.29");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const { spawn } = await import("node:child_process");
    const stranger = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const pid = stranger.pid!;
    try {
      writeLock(dataDir, {
        pid,
        port: 9,
        startedAt: new Date().toISOString(),
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify([{ tag_name: "v1.18.29" }]), {
            status: 200,
          });
        }
        if (url.includes("/global/health")) {
          return new Response(
            JSON.stringify({ healthy: true, version: "1.18.21" }),
            { status: 200 },
          );
        }
        if (url.includes("/session/status")) {
          return new Response("{}", { status: 200 });
        }
        return originalFetch(input);
      }) as typeof fetch;
      const result = await restartToApply(dataDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not a BB-launched serve/);
      expect(pidAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("refuses when BB sessions are busy and does not kill the lock pid", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.29\n");
    const { spawn } = await import("node:child_process");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const unrelatedPid = unrelated.pid!;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify([{ tag_name: "v1.18.29" }]), {
            status: 200,
          });
        }
        if (url.includes("/session/status")) {
          return new Response(
            JSON.stringify({ ses_busy: { type: "busy" } }),
            { status: 200 },
          );
        }
        return originalFetch(input);
      }) as typeof fetch;
      const result = await restartToApply(dataDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/busy/i);
      expect(pidAlive(attached.pid)).toBe(true);
      expect(pidAlive(unrelatedPid)).toBe(true);
      expect(ownsSpawnedServe(attached.pid, attached.port, attached.startedAt ?? "")).toBe(true);
    } finally {
      try {
        process.kill(attached.pid, "SIGKILL");
      } catch {
        /* already dead */
      }
      try {
        process.kill(unrelatedPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("refuses when live task children are running", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.29\n");
    const pid = attached.pid;
    try {
      noteLiveTaskChild({
        parentSessionId: "ses_parent",
        childSessionId: "ses_child",
        running: true,
      });
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify([{ tag_name: "v1.18.29" }]), {
            status: 200,
          });
        }
        if (url.includes("/global/health")) {
          return new Response(
            JSON.stringify({ healthy: true, version: "1.18.21" }),
            { status: 200 },
          );
        }
        if (url.includes("/session/status")) {
          return new Response("{}", { status: 200 });
        }
        return originalFetch(input);
      }) as typeof fetch;
      const result = await restartToApply(dataDir);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/busy/i);
      expect(pidAlive(pid)).toBe(true);
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });

  it("refuses a replacement lock before sending any signal", async () => {
    const { home, dataDir } = withHome();
    writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.29\n");
    const { spawn } = await import("node:child_process");
    const replacement = spawn(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      { stdio: "ignore" },
    );
    const originalPid = attached.pid;
    const replacementPid = replacement.pid!;
    try {
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("api.github.com")) {
          return new Response(JSON.stringify([{ tag_name: "v1.18.29" }]), {
            status: 200,
          });
        }
        if (url.includes("/session/status")) {
          writeLock(dataDir, {
            pid: replacementPid,
            port: 10,
            startedAt: new Date().toISOString(),
          });
          return new Response("{}", { status: 200 });
        }
        return originalFetch(input);
      }) as typeof fetch;
      const originalKill = process.kill.bind(process);
      const signaled: number[] = [];
      process.kill = ((pid: number, signal?: NodeJS.Signals | number) => {
        if (signal && signal !== 0) signaled.push(pid);
        return originalKill(pid, signal);
      }) as typeof process.kill;
      try {
        const result = await restartToApply(dataDir);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/replaced/i);
        expect(signaled).not.toContain(-originalPid);
        expect(signaled).not.toContain(originalPid);
        expect(pidAlive(originalPid)).toBe(true);
        expect(pidAlive(replacementPid)).toBe(true);
      } finally {
        process.kill = originalKill;
      }
    } finally {
      for (const pid of [originalPid, replacementPid]) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });

  it("restarts the idle BB-owned serve onto the disk version without touching others", async () => {
    const { home, dataDir } = withHome();
    const bin = writeFakeBinary(home, "1.18.21");
    mockGithubPages([[{ tag: "v1.18.29" }]]);
    const attached = await attachOrSpawn({ dataDir, spawn: true });
    const oldPid = attached.pid;
    const { spawn } = await import("node:child_process");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      stdio: "ignore",
    });
    const unrelatedPid = unrelated.pid!;
    try {
      writeFileSync(join(home, ".opencode", "bin", "version"), "1.18.29\n");
      expect(readCliVersion(bin)).toBe("1.18.29");
      expect(ownsSpawnedServe(oldPid, attached.port, attached.startedAt ?? "")).toBe(true);
      const result = await restartToApply(dataDir);
      expect(result.ok).toBe(true);
      expect(result.diskVersion).toBe("1.18.29");
      expect(result.runningVersion).toBe("1.18.29");
      expect(pidAlive(oldPid)).toBe(false);
      expect(pidAlive(unrelatedPid)).toBe(true);
      const next = readLock(dataDir);
      expect(next?.pid).toBeDefined();
      expect(next?.pid).not.toBe(oldPid);
      expect(pidAlive(next!.pid)).toBe(true);
      if (next?.pid) {
        try {
          process.kill(-next.pid, "SIGKILL");
        } catch {
          try {
            process.kill(next.pid, "SIGKILL");
          } catch {
            /* already dead */
          }
        }
      }
    } finally {
      try {
        process.kill(oldPid, "SIGKILL");
      } catch {
        /* already dead */
      }
      try {
        process.kill(unrelatedPid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });
});

describe("process group signals", () => {
  it("forwards SIGTERM and SIGINT to a disposable process group", async () => {
    const { spawn } = await import("node:child_process");
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        detached: true,
        stdio: "ignore",
      });
      const pid = child.pid!;
      child.unref();
      const stop = forwardGroupSignals(pid);
      try {
        process.emit(signal);
        for (let i = 0; i < 40 && pidAlive(pid); i += 1) {
          await delay(50);
        }
        expect(pidAlive(pid)).toBe(false);
      } finally {
        stop();
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already dead */
        }
      }
    }
  });

  it("keeps the exclusive hold over descendant processes in the group", async () => {
    const { home } = withHome();
    const { spawn } = await import("node:child_process");
    const pidFile = join(home, "descendant.pid");
    const leader = spawn(
      process.execPath,
      [
        "-e",
        `const {spawn}=require("node:child_process");const fs=require("node:fs");const g=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});fs.writeFileSync(${JSON.stringify(pidFile)},String(g.pid));setInterval(()=>{},1000);`,
      ],
      { detached: true, stdio: "ignore" },
    );
    const pgid = leader.pid!;
    leader.unref();
    try {
      for (let i = 0; i < 40 && !existsSync(pidFile); i += 1) {
        await delay(50);
      }
      const descendant = Number(readFileSync(pidFile, "utf8"));
      expect(descendant).toBeGreaterThan(0);
      const token = acquireExclusive("install", "1.18.29");
      expect(token).toBeTruthy();
      expect(adoptExclusive(token!, pgid)).toBe(true);
      expect(inspectHold()).toEqual({ status: "live", kind: "install" });
      process.kill(pgid, "SIGKILL");
      for (let i = 0; i < 40 && pidAlive(pgid); i += 1) {
        await delay(50);
      }
      expect(pidAlive(pgid)).toBe(false);
      expect(pidAlive(descendant)).toBe(true);
      expect(processGroupAlive(pgid)).toBe(true);
      expect(inspectHold()).toEqual({ status: "live", kind: "install" });
      const stop = forwardGroupSignals(pgid);
      process.emit("SIGTERM");
      for (let i = 0; i < 40 && pidAlive(descendant); i += 1) {
        await delay(50);
      }
      stop();
      expect(pidAlive(descendant)).toBe(false);
      expect(processGroupAlive(pgid)).toBe(false);
      releaseExclusive(token!);
    } finally {
      try {
        process.kill(-pgid, "SIGKILL");
      } catch {
        /* already dead */
      }
      try {
        process.kill(pgid, "SIGKILL");
      } catch {
        /* already dead */
      }
    }
  });
});

describe("lifecycle vs spawn", () => {
  it("refuses spawn while exclusive restart is held", async () => {
    const { dataDir } = withHome();
    const token = acquireExclusive("restart");
    expect(token).toBeTruthy();
    await expect(attachOrSpawn({ dataDir, spawn: true })).rejects.toThrow(
      /already in progress/,
    );
    releaseExclusive(token!);
  });
});
