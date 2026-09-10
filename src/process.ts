import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  acquireStartGuard,
  exclusiveKind,
  holdBlockMessage,
  inspectHold,
  releaseStartGuard,
} from "./hold.js";

export const LOCK_FILE_NAME = "opencode.lock.json";
export const CLAIM_FILE_NAME = "opencode.lock.claim";
export const LAUNCH_FILE_NAME = "opencode.launch.json";
export const LAUNCH_GUARD_FILE = "opencode.launch.guard";
export const LAUNCH_OWNER = "bb-plugin-opencode";
const CLAIM_WAIT_ATTEMPTS = 80;
const SERVE_LOG_LIMIT = 40;

export interface OpenCodeLock {
  pid: number;
  port: number;
  startedAt: string;
  version?: string;
  cwd?: string;
}

export interface LaunchClaim {
  owner: typeof LAUNCH_OWNER;
  pid: number;
  port: number;
  startedAt: string;
  token: string;
  startIdentity: string;
}

export type LaunchIdentity = Pick<
  LaunchClaim,
  "pid" | "port" | "startedAt" | "token"
>;

function isLaunchToken(token: string): boolean {
  return /^[0-9a-f]{32}$/.test(token);
}

export function launchIdentityEqual(
  left: LaunchIdentity,
  right: LaunchIdentity,
): boolean {
  return (
    left.pid === right.pid &&
    left.port === right.port &&
    left.startedAt === right.startedAt &&
    left.token === right.token
  );
}

export interface AttachResult {
  url: string;
  pid: number;
  port: number;
  spawned: boolean;
  cwd?: string;
  startedAt?: string;
}

const serveLog: string[] = [];

export function recentServeLog(limit = SERVE_LOG_LIMIT): string[] {
  return serveLog.slice(-Math.max(1, limit));
}

export function pushServeLog(chunk: string): void {
  for (const line of chunk.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    serveLog.push(trimmed);
    if (serveLog.length > SERVE_LOG_LIMIT) serveLog.shift();
  }
}

export function sharedLockDir(): string {
  return join(process.env.HOME ?? "/tmp", ".bb", "plugins", "opencode");
}

export function lockPath(_dataDir: string): string {
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, LOCK_FILE_NAME);
}

export function claimPath(): string {
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, CLAIM_FILE_NAME);
}

export function readLock(dataDir: string): OpenCodeLock | undefined {
  const path = lockPath(dataDir);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as OpenCodeLock;
  } catch {
    return undefined;
  }
}

export function writeLock(dataDir: string, lock: OpenCodeLock): void {
  writeFileSync(lockPath(dataDir), `${JSON.stringify(lock)}\n`);
}

export function removeLock(dataDir: string): void {
  const path = lockPath(dataDir);
  if (existsSync(path)) unlinkSync(path);
}

function removeLockIfOwned(dataDir: string, expected: OpenCodeLock): void {
  const current = readLock(dataDir);
  if (current?.pid !== expected.pid || current.port !== expected.port) return;
  removeLock(dataDir);
}

function launchPath(): string {
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, LAUNCH_FILE_NAME);
}

let startIdentityForTests: string | null | undefined;

export function setProcessStartIdentityForTests(value?: string | null): void {
  startIdentityForTests = value;
}

export function processStartIdentity(pid: number): string | null {
  if (startIdentityForTests !== undefined) return startIdentityForTests;
  if (process.platform === "win32") return null;
  if (!pidAlive(pid)) return null;
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      const starttime = stat.slice(close + 1).trim().split(/\s+/)[19];
      if (!starttime || !/^\d+$/.test(starttime)) return null;
      return `linux:${starttime}`;
    } catch {
      return null;
    }
  }
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1_000,
    });
    if (result.status !== 0) return null;
    const line = result.stdout.trim();
    if (!line) return null;
    return `ps:${line}`;
  } catch {
    return null;
  }
}

function parseLaunchClaim(raw: unknown): LaunchClaim | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row.owner !== LAUNCH_OWNER) return null;
  if (typeof row.pid !== "number" || !Number.isInteger(row.pid) || row.pid <= 0) {
    return null;
  }
  if (typeof row.port !== "number" || !Number.isInteger(row.port) || row.port <= 0) {
    return null;
  }
  if (typeof row.startedAt !== "string" || !row.startedAt) return null;
  if (typeof row.token !== "string" || !/^[0-9a-f]{32}$/.test(row.token)) return null;
  if (typeof row.startIdentity !== "string" || !row.startIdentity) return null;
  return {
    owner: LAUNCH_OWNER,
    pid: row.pid,
    port: row.port,
    startedAt: row.startedAt,
    token: row.token,
    startIdentity: row.startIdentity,
  };
}

export function readLaunchClaim(): LaunchClaim | null {
  const path = launchPath();
  if (!existsSync(path)) return null;
  try {
    return parseLaunchClaim(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return null;
  }
}

function writeLaunchAtomic(claim: LaunchClaim): void {
  const path = launchPath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(claim)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* platform may ignore mode */
  }
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    /* platform may ignore mode */
  }
}

function launchGuardPath(): string {
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, LAUNCH_GUARD_FILE);
}

export function launchGuardBlockMessage(): string | null {
  if (!existsSync(join(sharedLockDir(), LAUNCH_GUARD_FILE))) return null;
  return `OpenCode launch guard is stuck. Confirm no ownership operation or updater is active, then remove ${LAUNCH_GUARD_FILE} from the plugin data directory.`;
}

function tryAcquireLaunchGuard(): string | null {
  const path = launchGuardPath();
  const token = randomBytes(16).toString("hex");
  try {
    writeFileSync(path, `${token}\n`, { flag: "wx", mode: 0o600 });
    try {
      chmodSync(path, 0o600);
    } catch {
      /* platform may ignore mode */
    }
    return token;
  } catch {
    return null;
  }
}

function releaseLaunchGuard(token: string): void {
  const path = launchGuardPath();
  try {
    const current = readFileSync(path, "utf8").trim();
    if (current !== token) return;
    unlinkSync(path);
  } catch {
    /* ignore */
  }
}

let launchStopHoldHook: (() => void | Promise<void>) | undefined;

export function setLaunchStopHoldHookForTests(
  hook?: () => void | Promise<void>,
): void {
  launchStopHoldHook = hook;
}

export function persistLaunchClaim(
  lock: Pick<OpenCodeLock, "pid" | "port" | "startedAt">,
): string | null {
  const startIdentity = processStartIdentity(lock.pid);
  if (!startIdentity) return null;
  const guard = tryAcquireLaunchGuard();
  if (!guard) return null;
  try {
    const token = randomBytes(16).toString("hex");
    writeLaunchAtomic({
      owner: LAUNCH_OWNER,
      pid: lock.pid,
      port: lock.port,
      startedAt: lock.startedAt,
      token,
      startIdentity,
    });
    if (processStartIdentity(lock.pid) !== startIdentity) {
      removeLaunchClaimIfOwned({ ...lock, token });
      return null;
    }
    return token;
  } finally {
    releaseLaunchGuard(guard);
  }
}

export function removeLaunchClaimIfOwned(expected: LaunchIdentity): void {
  const claim = readLaunchClaim();
  if (!claim || !launchIdentityEqual(claim, expected)) return;
  try {
    unlinkSync(launchPath());
  } catch {
    /* ignore */
  }
}

function removeExactLaunchClaim(expected: LaunchIdentity): void {
  const guard = tryAcquireLaunchGuard();
  if (!guard) return;
  try {
    removeLaunchClaimIfOwned(expected);
  } finally {
    releaseLaunchGuard(guard);
  }
}

export type SpawnOwnership =
  | { ok: true }
  | { ok: false; error: string };

export function spawnOwnership(
  pid: number,
  port: number,
  startedAt: string,
  token?: string,
): SpawnOwnership {
  if (token !== undefined && !isLaunchToken(token)) {
    return { ok: false, error: "OpenCode pid is not a BB-launched serve" };
  }
  if (!pidAlive(pid)) {
    return { ok: false, error: "BB OpenCode lock pid is not alive" };
  }
  const identity = processStartIdentity(pid);
  if (!identity) {
    return {
      ok: false,
      error: "OpenCode launch ownership cannot be proven on this platform",
    };
  }
  const claim = readLaunchClaim();
  if (!claim) {
    return { ok: false, error: "OpenCode pid is not a BB-launched serve" };
  }
  if (
    claim.pid !== pid ||
    claim.port !== port ||
    claim.startedAt !== startedAt ||
    (token !== undefined && claim.token !== token)
  ) {
    return { ok: false, error: "OpenCode pid is not a BB-launched serve" };
  }
  if (claim.startIdentity !== identity) {
    return {
      ok: false,
      error: "OpenCode pid was reused; launch claim does not match",
    };
  }
  const mem = spawnedServes.get(pid);
  if (mem && (mem.port !== port || mem.startedAt !== startedAt)) {
    return { ok: false, error: "OpenCode pid is not a BB-launched serve" };
  }
  return { ok: true };
}

/** Detached OpenCode serves lead their own process group. */
function signalServe(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
    } catch {
      /* older/non-detached serve */
    }
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

const spawnedServes = new Map<
  number,
  { port: number; startedAt: string; child: ReturnType<typeof spawn> }
>();

export function lockIdentityEqual(
  left: Pick<OpenCodeLock, "pid" | "port" | "startedAt">,
  right: Pick<OpenCodeLock, "pid" | "port" | "startedAt">,
): boolean {
  return (
    left.pid === right.pid &&
    left.port === right.port &&
    left.startedAt === right.startedAt
  );
}

export function ownsSpawnedServe(
  pid: number,
  port: number,
  startedAt: string,
): boolean {
  return spawnOwnership(pid, port, startedAt).ok;
}

export function resetSpawnedServesForTests(): void {
  spawnedServes.clear();
}

/** Signal only this captured lock. Refuse if the file already names another pid. */
export async function stopServeIf(
  dataDir: string,
  expected: OpenCodeLock,
  token: string,
): Promise<"stopped" | "replaced" | "missing" | "unowned" | "alive"> {
  if (!isLaunchToken(token)) return "unowned";
  const guard = tryAcquireLaunchGuard();
  if (!guard) return "unowned";
  try {
    if (
      !spawnOwnership(expected.pid, expected.port, expected.startedAt, token).ok
    ) {
      return "unowned";
    }
    const current = readLock(dataDir);
    if (!current) return "missing";
    if (!lockIdentityEqual(current, expected)) {
      return "replaced";
    }
    if (launchStopHoldHook) await launchStopHoldHook();
    const owned = spawnedServes.get(expected.pid);
    if (pidAlive(expected.pid)) {
      try {
        signalServe(expected.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
      const deadAfterTerm = await waitForDeath(expected.pid, owned?.child, 1_200);
      if (!deadAfterTerm) {
        try {
          signalServe(expected.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
        const deadAfterKill = await waitForDeath(expected.pid, owned?.child, 800);
        if (!deadAfterKill) return "alive";
      }
    }
    const still = readLock(dataDir);
    if (still && !lockIdentityEqual(still, expected)) {
      spawnedServes.delete(expected.pid);
      return "replaced";
    }
    removeLockIfOwned(dataDir, expected);
    removeLaunchClaimIfOwned({ ...expected, token });
    spawnedServes.delete(expected.pid);
    return "stopped";
  } finally {
    releaseLaunchGuard(guard);
  }
}

async function waitForDeath(
  pid: number,
  child: ReturnType<typeof spawn> | undefined,
  ms: number,
): Promise<boolean> {
  if (!pidAlive(pid)) return true;
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    if (child && child.exitCode !== null) return !pidAlive(pid);
    await delay(50);
  }
  return !pidAlive(pid);
}

function pidIsZombie(pid: number): boolean {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      const state = stat.slice(close + 1).trim().split(/\s+/)[0];
      return state === "Z";
    } catch {
      return false;
    }
  }
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "state="], {
      encoding: "utf8",
      timeout: 500,
    });
    return /^\s*Z/i.test(result.stdout);
  } catch {
    return false;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !pidIsZombie(pid);
}

async function dropUnpublished(
  child: ReturnType<typeof spawn> | undefined,
): Promise<void> {
  const pid = child?.pid;
  if (!pid) return;
  spawnedServes.delete(pid);
  try {
    signalServe(pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  if (!(await waitForDeath(pid, child, 1_200))) {
    try {
      signalServe(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
    await waitForDeath(pid, child, 800);
  }
}

export function isAbortTimeout(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const message = (error as { message?: unknown }).message;
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    (typeof message === "string" && /aborted due to timeout/i.test(message))
  );
}

async function probePort(port: number): Promise<"ok" | "slow" | "dead"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok ? "ok" : "dead";
  } catch (error) {
    return isAbortTimeout(error) ? "slow" : "dead";
  }
}

export async function portListening(port: number): Promise<boolean> {
  return (await probePort(port)) === "ok";
}

export function isLockStale(lock: OpenCodeLock): boolean {
  return !pidAlive(lock.pid);
}

/** Drop the lock only when the port is dead. A slow answer is not a missing serve. */
export async function reclaimIfStale(dataDir: string): Promise<boolean> {
  const lock = readLock(dataDir);
  if (!lock) return false;
  for (let i = 0; i < 3; i += 1) {
    const probe = await probePort(lock.port);
    if (probe === "ok" || probe === "slow") return false;
    if (i < 2) await delay(150);
  }
  removeLock(dataDir);
  return true;
}

export async function attachIfHealthy(
  dataDir: string,
): Promise<AttachResult | undefined> {
  const lock = readLock(dataDir);
  if (!lock) return undefined;
  if (!(await portListening(lock.port))) return undefined;
  return {
    url: `http://127.0.0.1:${lock.port}`,
    pid: lock.pid,
    port: lock.port,
    spawned: false,
    cwd: lock.cwd,
    startedAt: lock.startedAt,
  };
}

function readSpawnClaim(): { pid: number; token: string } | null {
  const path = claimPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      pid?: unknown;
      token?: unknown;
    };
    if (typeof parsed.pid !== "number" || !Number.isInteger(parsed.pid) || parsed.pid <= 0) {
      return null;
    }
    if (typeof parsed.token !== "string" || !/^[0-9a-f]{32}$/.test(parsed.token)) {
      return null;
    }
    return { pid: parsed.pid, token: parsed.token };
  } catch {
    return null;
  }
}

function takeSpawnClaimIfToken(token: string): boolean {
  const path = claimPath();
  const drop = `${path}.${token}`;
  try {
    renameSync(path, drop);
  } catch {
    return false;
  }
  try {
    const moved = JSON.parse(readFileSync(drop, "utf8")) as { token?: unknown; pid?: unknown };
    if (moved.token !== token) {
      try {
        renameSync(drop, path);
      } catch {
        /* successor already occupies path */
      }
      return false;
    }
    unlinkSync(drop);
    return true;
  } catch {
    try {
      renameSync(drop, path);
    } catch {
      /* ignore */
    }
    return false;
  }
}

export function reclaimStaleClaim(): boolean {
  const claim = readSpawnClaim();
  if (!claim) return false;
  if (pidAlive(claim.pid)) return false;
  return takeSpawnClaimIfToken(claim.token);
}

export function removeSpawnClaimIfOwned(token: string): void {
  takeSpawnClaimIfToken(token);
}

/** The bridge binds its private serve to loopback and does not send Basic auth. */
export function openCodeServeEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  delete childEnv.OPENCODE_SERVER_PASSWORD;
  delete childEnv.OPENCODE_SERVER_USERNAME;
  return childEnv;
}

export function canonicalPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

export function resolveOpenCodeBinary(): string | undefined {
  const override = process.env.OPENCODE_BIN;
  if (override) {
    return canonicalPath(override);
  }
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const candidate of candidates) {
    const resolved = canonicalPath(candidate);
    if (resolved) return resolved;
  }
  return undefined;
}

async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local port"));
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

export async function attachOrSpawn(args: {
  dataDir: string;
  binary?: string;
  spawn?: boolean;
  during?: string;
}): Promise<AttachResult> {
  if (args.during !== "restart" && inspectHold().status !== "clear") {
    throw new Error(holdBlockMessage() ?? "OpenCode maintenance already in progress");
  }
  const busy = exclusiveKind();
  if (busy && busy !== args.during) {
    throw new Error(`OpenCode ${busy} already in progress`);
  }
  mkdirSync(args.dataDir, { recursive: true });
  await reclaimIfStale(args.dataDir);
  const existing = await attachIfHealthy(args.dataDir);
  if (existing) return existing;

  const leftoverLock = readLock(args.dataDir);
  if (leftoverLock) {
    throw new Error(
      `OpenCode serve on :${leftoverLock.port} did not answer in time. Not spawning another.`,
    );
  }

  if (args.spawn === false) {
    throw new Error(
      "OpenCode serve is not attached. Start a thread to spawn one, or recycle when idle.",
    );
  }

  const spawnGuard =
    args.during === "restart" ? null : acquireStartGuard();
  if (args.during !== "restart" && !spawnGuard) {
    throw new Error("OpenCode maintenance already in progress");
  }
  try {
  const claim = claimPath();
  reclaimStaleClaim();
  let claimed = false;
  let spawnClaimToken = "";
  let child: ReturnType<typeof spawn> | undefined;
  let lockPublished = false;
  try {
    spawnClaimToken = randomBytes(16).toString("hex");
    writeFileSync(
      claim,
      `${JSON.stringify({
        pid: process.pid,
        token: spawnClaimToken,
        startedAt: new Date().toISOString(),
      })}\n`,
      { flag: "wx" },
    );
    claimed = true;
  } catch {
    for (let i = 0; i < CLAIM_WAIT_ATTEMPTS; i += 1) {
      await delay(100);
      reclaimStaleClaim();
      const attached = await attachIfHealthy(args.dataDir);
      if (attached) return attached;
    }
    const leftover = readLock(args.dataDir);
    if (leftover) {
      throw new Error(
        `Leftover OpenCode lock on :${leftover.port}. Attach or tell me to recycle; not spawning another.`,
      );
    }
    throw new Error(
      "Timed out waiting for the other worker to publish the OpenCode lock",
    );
  }

  try {
    const raced = await attachIfHealthy(args.dataDir);
    if (raced) return raced;
    const binary = args.binary ?? resolveOpenCodeBinary();
    if (!binary) throw new Error("OpenCode binary not found");
    const port = await allocatePort();
    child = spawn(
      binary,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: openCodeServeEnvironment(),
        cwd: args.dataDir,
      },
    );
    child.stderr?.on("data", (buf: Buffer | string) => {
      pushServeLog(String(buf));
    });
    child.stdout?.on("data", (buf: Buffer | string) => {
      pushServeLog(String(buf));
    });
    child.unref();
    for (let i = 0; i < 80; i += 1) {
      if (await portListening(port)) break;
      if (child.exitCode !== null) {
        const tail = recentServeLog(8).join(" | ");
        throw new Error(
          `OpenCode serve exited with ${child.exitCode}${tail ? `: ${tail}` : ""}`,
        );
      }
      await delay(100);
    }
    if (!child.pid || !(await portListening(port))) {
      const tail = recentServeLog(8).join(" | ");
      throw new Error(
        `OpenCode serve did not become healthy${tail ? `: ${tail}` : ""}`,
      );
    }
    const publishedLock: OpenCodeLock = {
      pid: child.pid,
      port,
      startedAt: new Date().toISOString(),
      cwd: args.dataDir,
    };
    const launchToken = persistLaunchClaim(publishedLock);
    if (!launchToken) {
      await dropUnpublished(child);
      throw new Error(
        launchGuardBlockMessage() ??
          "OpenCode launch ownership cannot be proven on this platform",
      );
    }
    spawnedServes.set(child.pid, {
      port,
      startedAt: publishedLock.startedAt,
      child,
    });
    child.once("exit", () => {
      spawnedServes.delete(publishedLock.pid);
      removeLockIfOwned(args.dataDir, publishedLock);
      removeExactLaunchClaim({ ...publishedLock, token: launchToken });
    });
    try {
      writeLock(args.dataDir, publishedLock);
    } catch {
      spawnedServes.delete(publishedLock.pid);
      removeExactLaunchClaim({ ...publishedLock, token: launchToken });
      await dropUnpublished(child);
      throw new Error("OpenCode lock could not be published");
    }
    lockPublished = true;
    if (child.exitCode !== null) {
      removeLockIfOwned(args.dataDir, publishedLock);
      removeExactLaunchClaim({ ...publishedLock, token: launchToken });
    }
    return {
      url: `http://127.0.0.1:${port}`,
      pid: child.pid,
      port,
      spawned: true,
      cwd: args.dataDir,
      startedAt: publishedLock.startedAt,
    };
  } finally {
    if (child && !lockPublished) {
      await dropUnpublished(child);
    }
    if (claimed && spawnClaimToken) {
      removeSpawnClaimIfOwned(spawnClaimToken);
    }
  }
  } finally {
    if (spawnGuard) releaseStartGuard(spawnGuard);
  }
}
