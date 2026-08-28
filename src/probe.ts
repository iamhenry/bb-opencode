import {
  isVersionInWindow,
  SDK_PIN,
  SERVER_VERSION_MAX_EXCLUSIVE,
  SERVER_VERSION_MIN,
  versionSkewMessage,
} from "./identity.js";
import type { OpenCodeClient } from "./client.js";
import {
  attachOrSpawn,
  readLock,
  recentServeLog,
  resolveOpenCodeBinary,
} from "./process.js";

export interface ProbeResult {
  binaryPath: string | undefined;
  serverVersion: string | undefined;
  attached: boolean;
  spawned: boolean;
  port: number | undefined;
  pid: number | undefined;
  supportedRange: string;
  sdkPin: string;
  authError?: string;
  error?: string;
  needsConfiguration: boolean;
  serveCwd?: string;
  configSummary?: string;
  serveLog: string[];
}

function rangeLabel(): string {
  return `${SERVER_VERSION_MIN}–<${SERVER_VERSION_MAX_EXCLUSIVE}`;
}

export function summarizeOpenCodeConfig(config: unknown): string | undefined {
  if (!config || typeof config !== "object") return undefined;
  const record = config as Record<string, unknown>;
  const permission = record.permission ?? record.permissions;
  const snippet = {
    ...(typeof record.directory === "string"
      ? { directory: record.directory }
      : {}),
    ...(permission !== undefined ? { permission } : {}),
    ...(typeof record.model === "string" ? { model: record.model } : {}),
    ...(typeof record.small_model === "string"
      ? { small_model: record.small_model }
      : {}),
  };
  const text = JSON.stringify(snippet);
  return text === "{}" ? undefined : text.slice(0, 500);
}

export async function probeOpenCode(args: {
  dataDir: string;
  acquire: (url: string) => OpenCodeClient;
}): Promise<ProbeResult> {
  const binaryPath = resolveOpenCodeBinary();
  const range = rangeLabel();
  if (!binaryPath) {
    return {
      binaryPath: undefined,
      serverVersion: undefined,
      attached: false,
      spawned: false,
      port: undefined,
      pid: undefined,
      supportedRange: range,
      sdkPin: SDK_PIN,
      error: "OpenCode binary not found on PATH",
      needsConfiguration: true,
      serveLog: recentServeLog(),
    };
  }

  try {
    // ponytail: probe now spawns an idle serve at bb startup so the
    // needs-configuration badge doesn't stick on a transient "not attached".
    // If a resident idle serve becomes a problem, gate behind a plugin setting.
    const attached = await attachOrSpawn({
      dataDir: args.dataDir,
      binary: binaryPath,
      spawn: true,
    });
    const client = args.acquire(attached.url);
    const health = await client.health();
    let configSummary: string | undefined;
    try {
      configSummary = summarizeOpenCodeConfig(await client.getConfig());
    } catch {
      /* config is diagnostic-only */
    }
    const lock = readLock(args.dataDir);
    if (!isVersionInWindow(health.version)) {
      return {
        binaryPath,
        serverVersion: health.version,
        attached: true,
        spawned: false,
        port: attached.port,
        pid: attached.pid,
        supportedRange: range,
        sdkPin: SDK_PIN,
        error: versionSkewMessage(health.version),
        needsConfiguration: true,
        serveCwd: attached.cwd ?? lock?.cwd,
        configSummary,
        serveLog: recentServeLog(),
      };
    }
    let authError: string | undefined;
    try {
      const catalog = await client.providers();
      if (!catalog.providers || catalog.providers.length === 0) {
        authError = "OpenCode returned no providers. Check authentication.";
      }
    } catch (error) {
      authError = error instanceof Error ? error.message : String(error);
    }
    return {
      binaryPath,
      serverVersion: health.version,
      attached: true,
      spawned: false,
      port: attached.port,
      pid: lock?.pid ?? attached.pid,
      supportedRange: range,
      sdkPin: SDK_PIN,
      authError,
      needsConfiguration: false,
      serveCwd: attached.cwd ?? lock?.cwd,
      configSummary,
      serveLog: recentServeLog(),
    };
  } catch (error) {
    const lock = readLock(args.dataDir);
    return {
      binaryPath,
      serverVersion: undefined,
      attached: false,
      spawned: false,
      port: lock?.port,
      pid: lock?.pid,
      supportedRange: range,
      sdkPin: SDK_PIN,
      error: error instanceof Error ? error.message : String(error),
      needsConfiguration: true,
      serveCwd: lock?.cwd,
      serveLog: recentServeLog(),
    };
  }
}
