import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const LOCK_FILE_NAME = "opencode.lock.json";

export interface OpenCodeLock {
  pid: number;
  port: number;
  startedAt: string;
  version?: string;
}

export function sharedLockDir(): string {
  return join(process.env.HOME ?? "/tmp", ".bb", "plugins", "opencode");
}

export function lockPath(_dataDir: string): string {
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, LOCK_FILE_NAME);
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

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function portListening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/global/health`, {
      signal: AbortSignal.timeout(800),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export function isLockStale(lock: OpenCodeLock): boolean {
  return !pidAlive(lock.pid);
}

export async function reclaimIfStale(dataDir: string): Promise<boolean> {
  const lock = readLock(dataDir);
  if (!lock) return false;
  const listening = await portListening(lock.port);
  if (!pidAlive(lock.pid) || !listening) {
    removeLock(dataDir);
    return true;
  }
  return false;
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
}): Promise<{ url: string; pid: number; port: number; spawned: boolean }> {
  mkdirSync(args.dataDir, { recursive: true });
  await reclaimIfStale(args.dataDir);
  const existing = readLock(args.dataDir);
  if (existing && pidAlive(existing.pid) && (await portListening(existing.port))) {
    return {
      url: `http://127.0.0.1:${existing.port}`,
      pid: existing.pid,
      port: existing.port,
      spawned: false,
    };
  }

  const claimPath = join(sharedLockDir(), "opencode.lock.claim");
  let claimed = false;
  try {
    writeFileSync(claimPath, String(process.pid), { flag: "wx" });
    claimed = true;
  } catch {
    for (let i = 0; i < 40; i += 1) {
      await delay(100);
      const lock = readLock(args.dataDir);
      if (lock && (await portListening(lock.port))) {
        return {
          url: `http://127.0.0.1:${lock.port}`,
          pid: lock.pid,
          port: lock.port,
          spawned: false,
        };
      }
    }
    throw new Error("Timed out waiting for the other worker to publish the OpenCode lock");
  }

  try {
    const binary = args.binary ?? resolveOpenCodeBinary();
    if (!binary) throw new Error("OpenCode binary not found");
    const port = await allocatePort();
    const child = spawn(
      binary,
      ["serve", "--port", String(port), "--hostname", "127.0.0.1"],
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: process.env,
        cwd: args.dataDir,
      },
    );
    child.unref();
    for (let i = 0; i < 80; i += 1) {
      if (await portListening(port)) break;
      if (child.exitCode !== null) {
        throw new Error(`OpenCode serve exited with ${child.exitCode}`);
      }
      await delay(100);
    }
    if (!child.pid || !(await portListening(port))) {
      throw new Error("OpenCode serve did not become healthy");
    }
    writeLock(args.dataDir, {
      pid: child.pid,
      port,
      startedAt: new Date().toISOString(),
    });
    return {
      url: `http://127.0.0.1:${port}`,
      pid: child.pid,
      port,
      spawned: true,
    };
  } finally {
    if (claimed) {
      try {
        unlinkSync(claimPath);
      } catch {
        /* ignore */
      }
    }
  }
}
