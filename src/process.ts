import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const LOCK_FILE_NAME = "opencode.lock.json";
export const CLAIM_FILE_NAME = "opencode.lock.claim";
const CLAIM_STALE_MS = 5_000;
const CLAIM_WAIT_ATTEMPTS = 80;
const SERVE_LOG_LIMIT = 40;

export interface OpenCodeLock {
  pid: number;
  port: number;
  startedAt: string;
  version?: string;
  cwd?: string;
}

export interface AttachResult {
  url: string;
  pid: number;
  port: number;
  spawned: boolean;
  cwd?: string;
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

/** Detached OpenCode serves lead their own process group. */
function signalServe(pid: number, signal: NodeJS.Signals): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      /* older/non-detached serve; fall back to the leader */
    }
  }
  process.kill(pid, signal);
}

/** Kill the locked serve and drop only the lock still owned by that serve. */
export async function stopServe(dataDir: string): Promise<boolean> {
  const lock = readLock(dataDir);
  if (!lock) return false;
  if (pidAlive(lock.pid)) {
    try {
      signalServe(lock.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 30; i += 1) {
      if (!pidAlive(lock.pid)) break;
      await delay(100);
    }
    if (pidAlive(lock.pid)) {
      try {
        signalServe(lock.pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  removeLockIfOwned(dataDir, lock);
  return true;
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
  };
}

export function reclaimStaleClaim(now = Date.now()): boolean {
  const path = claimPath();
  if (!existsSync(path)) return false;
  try {
    const raw = readFileSync(path, "utf8").trim();
    let pid: number | undefined;
    let startedAt: number | undefined;
    try {
      const parsed = JSON.parse(raw) as { pid?: unknown; startedAt?: unknown };
      if (typeof parsed.pid === "number") pid = parsed.pid;
      if (typeof parsed.startedAt === "string") {
        const parsedAt = Date.parse(parsed.startedAt);
        if (!Number.isNaN(parsedAt)) startedAt = parsedAt;
      }
    } catch {
      const asPid = Number(raw);
      if (Number.isFinite(asPid)) pid = asPid;
    }
    const mtime = statSync(path).mtimeMs;
    const age = now - (startedAt ?? mtime);
    if (pid !== undefined && pidAlive(pid) && age < CLAIM_STALE_MS) {
      return false;
    }
    unlinkSync(path);
    return true;
  } catch {
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  }
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

export function resolveOpenCodeBinary(): string | undefined {
  const override = process.env.OPENCODE_BIN;
  if (override) {
    return existsSync(override) ? override : undefined;
  }
  const home = process.env.HOME ?? "";
  const candidates = [
    join(home, ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
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
}): Promise<AttachResult> {
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

  const claim = claimPath();
  reclaimStaleClaim();
  let claimed = false;
  let child: ReturnType<typeof spawn> | undefined;
  let lockPublished = false;
  try {
    writeFileSync(
      claim,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
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
    child.once("exit", () => removeLockIfOwned(args.dataDir, publishedLock));
    writeLock(args.dataDir, publishedLock);
    lockPublished = true;
    if (child.exitCode !== null) removeLockIfOwned(args.dataDir, publishedLock);
    return {
      url: `http://127.0.0.1:${port}`,
      pid: child.pid,
      port,
      spawned: true,
      cwd: args.dataDir,
    };
  } finally {
    if (child && !lockPublished) {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
    if (claimed) {
      try {
        unlinkSync(claim);
      } catch {
        /* ignore */
      }
    }
  }
}
