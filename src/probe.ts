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
  pidAlive,
  readLock,
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
}

export async function probeOpenCode(args: {
  dataDir: string;
  acquire: (url: string) => OpenCodeClient;
}): Promise<ProbeResult> {
  const binaryPath = resolveOpenCodeBinary();
  const range = `${SERVER_VERSION_MIN}–<${SERVER_VERSION_MAX_EXCLUSIVE}`;
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
    };
  }

  try {
    const attached = await attachOrSpawn({ dataDir: args.dataDir, binary: binaryPath });
    const client = args.acquire(attached.url);
    const health = await client.health();
    if (!isVersionInWindow(health.version)) {
      return {
        binaryPath,
        serverVersion: health.version,
        attached: !attached.spawned,
        spawned: attached.spawned,
        port: attached.port,
        pid: attached.pid,
        supportedRange: range,
        sdkPin: SDK_PIN,
        error: versionSkewMessage(health.version),
        needsConfiguration: true,
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
    const lock = readLock(args.dataDir);
    return {
      binaryPath,
      serverVersion: health.version,
      attached: !attached.spawned,
      spawned: attached.spawned,
      port: attached.port,
      pid: lock?.pid ?? attached.pid,
      supportedRange: range,
      sdkPin: SDK_PIN,
      authError,
      needsConfiguration: false,
    };
  } catch (error) {
    const lock = readLock(args.dataDir);
    return {
      binaryPath,
      serverVersion: undefined,
      attached: Boolean(lock && pidAlive(lock.pid)),
      spawned: false,
      port: lock?.port,
      pid: lock?.pid,
      supportedRange: range,
      sdkPin: SDK_PIN,
      error: error instanceof Error ? error.message : String(error),
      needsConfiguration: true,
    };
  }
}
