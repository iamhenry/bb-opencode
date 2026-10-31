import { closeSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Service } from "@opencode/client/service";
import { endpointHeadersFor, rememberEndpointHeaders } from "./client.js";
import { acquireExclusive, exclusiveKind, holdBlockMessage, inspectHold, releaseExclusive } from "./hold.js";
import { debugLog } from "./debug-log.js";
import { managedServiceEnvironment, MANAGED_SUBAGENT_PLUGIN_ID } from "./managed-subagents.js";
import { listLiveTaskChildren } from "./task-live.js";

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
  const env = managedServiceEnvironment(sharedLockDir());
  await Service.stop();
  await register(await Service.ensure({ command: [binary, "serve", "--service"], env }));
}

let managedActivationTimer: ReturnType<typeof setInterval> | undefined;
let managedActivationBusy = false;

async function managedPluginConfigured(url: string): Promise<boolean> {
  const query = new URLSearchParams({ "location[directory]": sharedLockDir() });
  const response = await fetch(`${url}/api/config?${query}`, {
    headers: endpointHeadersFor(url),
    signal: AbortSignal.timeout(INFO_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Cannot inspect BB subagent policy (${response.status})`);
  // Plugin instances are lazy: /api/plugin is empty before the first tool.
  // Inspect loaded config instead, so an idle, correctly configured service
  // is not restarted just because no session has used the hook yet.
  const entries = await response.json() as Array<{ info?: { plugins?: Array<string | { package?: string }> } }>;
  const directory = join(sharedLockDir(), MANAGED_SUBAGENT_PLUGIN_ID);
  return entries.some((entry) => entry.info?.plugins?.some((plugin) =>
    (typeof plugin === "string" ? plugin : plugin.package) === directory,
  ));
}

/** An already-running service cannot receive a new environment until it is idle. */
function activateManagedPluginWhenIdle(binary: string): void {
  if (managedActivationTimer) return;
  managedActivationTimer = setInterval(() => {
    if (managedActivationBusy) return;
    managedActivationBusy = true;
    void (async () => {
      const info = await serviceInfo();
      if (!info) return;
      if (await managedPluginConfigured(info.url)) {
        stopManagedPluginActivation();
        return;
      }
      if (listLiveTaskChildren().some((child) => child.running) || await serviceIdle(info.url) !== true) return;
      // Busy services don't acquire a restart hold that could reject a new BB turn.
      const token = acquireExclusive("restart", MANAGED_SUBAGENT_PLUGIN_ID);
      if (!token) return;
      try {
        const current = await serviceInfo();
        if (!current || await managedPluginConfigured(current.url)) return;
        if (listLiveTaskChildren().some((child) => child.running) || await serviceIdle(current.url) !== true) return;
        // Stop retrying before the restart: a broken hook must not cause a restart loop.
        stopManagedPluginActivation();
        await restartService(binary);
        debugLog("BB subagent policy activated on idle service restart");
      } finally {
        releaseExclusive(token);
      }
    })().catch((error) => debugLog(`BB subagent policy activation: ${String(error)}`))
      .finally(() => { managedActivationBusy = false; });
  }, 2_000);
  managedActivationTimer.unref?.();
}

export function stopManagedPluginActivation(): void {
  clearInterval(managedActivationTimer);
  managedActivationTimer = undefined;
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
    endpoint = await Service.ensure({
      command: [binary, "serve", "--service"],
      env: managedServiceEnvironment(sharedLockDir()),
    });
  }
  if (!endpoint) throw new Error("OpenCode service did not start");
  const url = await register(endpoint);
  if (args.spawn !== false) {
    managedServiceEnvironment(sharedLockDir());
    activateManagedPluginWhenIdle(args.binary ?? resolveOpenCodeBinary() ?? "opencode");
  }
  const port = Number(new URL(url).port) || 0;
  return { url, pid: 0, port, spawned: false };
}
