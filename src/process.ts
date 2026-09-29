import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { endpointHeadersFor, rememberEndpointHeaders } from "./client.js";
import { exclusiveKind, holdBlockMessage, inspectHold } from "./hold.js";

const SERVICE_LOG_LIMIT = 40;
const SERVICE_LOG_TAIL_BYTES = 256 * 1024;
const INFO_TIMEOUT_MS = 2_000;

export interface AttachResult {
  url: string;
  pid: number;
  port: number;
  spawned: boolean;
  cwd?: string;
  startedAt?: string;
}

export interface ServiceInfo {
  url: string;
  version: string;
  pid: number;
}

/** Plugin-owned state dir shared by every BB bridge on this machine. */
export function sharedLockDir(): string {
  return join(process.env.HOME ?? "/tmp", ".bb", "plugins", "opencode");
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

/** Recent server warnings/errors from OpenCode's own service log (V2 has no BB-owned serve stdout). */
export function recentServeLog(limit = SERVICE_LOG_LIMIT): string[] {
  const path = join(
    process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"),
    "opencode",
    "log",
    "opencode.log",
  );
  try {
    const size = statSync(path).size;
    const length = Math.min(size, SERVICE_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    try {
      readSync(fd, buffer, 0, length, size - length);
    } finally {
      closeSync(fd);
    }
    return buffer
      .toString("utf8")
      .split(/\r?\n/)
      // Warnings and errors only: INFO lines echo every session's shell commands.
      .filter((line) => line.includes("role=server") && /level=(WARN|ERROR)/.test(line))
      .slice(-Math.max(1, limit))
      .map((line) => line.slice(0, 300));
  } catch {
    return [];
  }
}

async function register(endpoint: {
  url: string;
  auth?: { type: "basic"; username: string; password: string };
}): Promise<string> {
  rememberEndpointHeaders(endpoint.url, Service.headers(endpoint));
  return endpoint.url;
}

/** Version and pid of the running shared service, without starting one. */
export async function serviceInfo(): Promise<ServiceInfo | null> {
  try {
    const endpoint = await Service.discover();
    if (!endpoint) return null;
    const url = await register(endpoint);
    const response = await fetch(`${url}/api/info`, {
      headers: endpointHeadersFor(url),
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: unknown; pid?: unknown };
    if (typeof body.version !== "string") return null;
    return { url, version: body.version, pid: typeof body.pid === "number" ? body.pid : 0 };
  } catch {
    return null;
  }
}

/** IDs of sessions the shared service is currently running, or null when unknown. */
export async function activeSessionIds(url: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${url}/api/session/active`, {
      headers: endpointHeadersFor(url),
      signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: unknown };
    return new Set(body.data && typeof body.data === "object" ? Object.keys(body.data) : []);
  } catch {
    return null;
  }
}

/** True when the shared service reports no running session. */
export async function serviceIdle(url: string): Promise<boolean | "unknown"> {
  const active = await activeSessionIds(url);
  return active ? active.size === 0 : "unknown";
}

/** Stop the shared service and start it again from `binary` (TUI clients reconnect). */
export async function restartService(binary: string): Promise<void> {
  await Service.stop();
  await register(await Service.ensure({ command: [binary, "serve", "--service"] }));
}

/**
 * Attach to OpenCode V2's shared background service (the same one the TUI
 * uses). `spawn: false` only discovers; otherwise the official client starts
 * `opencode serve --service` when none is running.
 */
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
  let endpoint: Parameters<typeof register>[0] | undefined = await Service.discover();
  if (!endpoint) {
    if (args.spawn === false) {
      throw new Error(
        "OpenCode service is not running. Start a thread to launch it, or run `opencode service start`.",
      );
    }
    const binary = args.binary ?? resolveOpenCodeBinary() ?? "opencode";
    endpoint = await Service.ensure({ command: [binary, "serve", "--service"] });
  }
  if (!endpoint) throw new Error("OpenCode service did not start");
  const url = await register(endpoint);
  const port = Number(new URL(url).port) || 0;
  return { url, pid: 0, port, spawned: false };
}
