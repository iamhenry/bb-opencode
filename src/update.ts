import { spawn, spawnSync } from "node:child_process";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  compareVersionStrings,
  isVersionInWindow,
  parseExactVersion,
  SERVER_VERSION_MIN,
  versionSkewMessage,
} from "./identity.js";
import { fileURLToPath } from "node:url";
import {
  acquireExclusive,
  adoptExclusive,
  holdBlockMessage,
  processGroupAlive,
  releaseExclusive,
} from "./hold.js";
import {
  attachIfHealthy,
  attachOrSpawn,
  canonicalPath,
  launchGuardBlockMessage,
  lockIdentityEqual,
  pidAlive,
  portListening,
  readLaunchClaim,
  readLock,
  resolveOpenCodeBinary,
  spawnOwnership,
  stopServeIf,
  type OpenCodeLock,
} from "./process.js";
import { runningSessionIdsFromStatus } from "./session-status.js";
import { listLiveTaskChildren } from "./task-live.js";

const GITHUB_RELEASES =
  "https://api.github.com/repos/anomalyco/opencode/releases";
const VERSION_TIMEOUT_MS = 5_000;
export const LATEST_OK_CACHE_MS = 5 * 60_000;
export const LATEST_FAIL_CACHE_MS = 15_000;
export const GITHUB_PER_PAGE = 30;
export const GITHUB_MAX_PAGES = 5;

export type UpgradeMethod = "curl" | "npm" | "unknown";

export interface UpdateStatus {
  binaryPath: string | null;
  diskVersion: string | null;
  runningVersion: string | null;
  latestVersion: string | null;
  targetVersion: string | null;
  method: string | null;
  eligible: boolean;
  canRestart: boolean;
  current: boolean;
  error: string | null;
}

export interface MutationResult {
  ok: boolean;
  error: string | null;
  diskVersion: string | null;
  targetVersion: string | null;
  runningVersion: string | null;
  pendingRestart: boolean;
}

export type ProviderInstallEvent = {
  type: "started" | "output" | "completed" | "error";
  success?: boolean;
  exitCode?: number | null;
  message?: string;
};

export function selectEnrolledHost(
  hosts: ReadonlyArray<{ id: string; status: string }>,
  requested?: string | null,
): { ok: true; hostId: string } | { ok: false; error: string } {
  const connected = hosts.filter((host) => host.status === "connected");
  if (requested) {
    if (connected.some((host) => host.id === requested)) {
      return { ok: true, hostId: requested };
    }
    return {
      ok: false,
      error: "Requested host is not enrolled or connected",
    };
  }
  if (connected.length === 0) return { ok: false, error: "No enrolled host" };
  if (connected.length > 1) {
    return {
      ok: false,
      error: "Multiple enrolled hosts; pass hostId",
    };
  }
  return { ok: true, hostId: connected[0].id };
}

export function detectUpgradeMethod(
  binaryPath: string,
  home = process.env.HOME ?? homedir(),
): UpgradeMethod {
  const resolved = canonicalPath(binaryPath);
  if (!resolved) return "unknown";
  const managed = canonicalPath(join(home, ".opencode", "bin", "opencode"));
  if (managed && resolved === managed) return "curl";
  const npmBin = npmGlobalBinary();
  if (npmBin) {
    const npmResolved = canonicalPath(npmBin);
    if (npmResolved && npmResolved === resolved) return "npm";
  }
  return "unknown";
}

function npmGlobalBinary(): string | undefined {
  const result = spawnSync("npm", ["prefix", "-g"], {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
  });
  if (result.status !== 0) return undefined;
  const prefix = result.stdout.trim();
  if (!prefix) return undefined;
  return join(prefix, process.platform === "win32" ? "opencode.cmd" : "bin/opencode");
}

export function planInstall(input: {
  binaryPath: string | null;
  resolvedPath: string | null;
  diskVersion: string | null;
  targetVersion: string | null;
  method: UpgradeMethod | null;
}): { ok: true; binaryPath: string; target: string; method: "curl" | "npm" } | {
  ok: false;
  error: string;
} {
  if (!input.binaryPath || !input.resolvedPath) {
    return { ok: false, error: "OpenCode binary path is unknown" };
  }
  const binary = canonicalPath(input.binaryPath);
  const resolved = canonicalPath(input.resolvedPath);
  if (!binary || !resolved) {
    return { ok: false, error: "Install path could not be resolved" };
  }
  if (binary !== resolved) {
    return { ok: false, error: "Install path does not match the spawn resolver" };
  }
  if (input.method !== "curl" && input.method !== "npm") {
    return {
      ok: false,
      error: "Upgrade method is unknown or interactive",
    };
  }
  if (!input.diskVersion || !input.targetVersion) {
    return { ok: false, error: "Disk or target version is unknown" };
  }
  if (!parseExactVersion(input.diskVersion) || !parseExactVersion(input.targetVersion)) {
    return { ok: false, error: "Cannot compare disk and target versions" };
  }
  if (!isVersionInWindow(input.targetVersion)) {
    return { ok: false, error: versionSkewMessage(input.targetVersion) };
  }
  const order = compareVersionStrings(input.targetVersion, input.diskVersion);
  if (order === null) {
    return { ok: false, error: "Cannot compare disk and target versions" };
  }
  if (order <= 0) {
    return { ok: false, error: "Refusing to install a target that is not newer" };
  }
  return {
    ok: true,
    binaryPath: binary,
    target: input.targetVersion,
    method: input.method,
  };
}

export function readCliVersion(binaryPath: string): string | null {
  const result = spawnSync(binaryPath, ["--version"], {
    encoding: "utf8",
    timeout: VERSION_TIMEOUT_MS,
  });
  if (result.status !== 0) return null;
  const line = `${result.stdout ?? ""}`.trim().split(/\r?\n/)[0] ?? "";
  return parseExactVersion(line);
}

let latestCache: { at: number; value: string | null; ok: boolean } | null = null;

export function resetLatestCacheForTests(): void {
  latestCache = null;
}

export function ageLatestCacheForTests(ms: number): void {
  if (latestCache) latestCache.at = Date.now() - ms;
}

export async function fetchLatestSupported(): Promise<string | null> {
  const now = Date.now();
  if (latestCache) {
    const ttl = latestCache.ok ? LATEST_OK_CACHE_MS : LATEST_FAIL_CACHE_MS;
    if (now - latestCache.at < ttl) return latestCache.value;
  }
  const loaded = await loadHighestEligibleRelease();
  latestCache = { at: now, value: loaded.value, ok: loaded.ok };
  return loaded.value;
}

export function pickHighestEligibleRelease(
  tags: ReadonlyArray<{ tag_name?: unknown; prerelease?: unknown }>,
): string | null {
  let best: string | null = null;
  for (const release of tags) {
    if (release.prerelease === true) continue;
    if (typeof release.tag_name !== "string") continue;
    const version = parseExactVersion(release.tag_name);
    if (!version || !isVersionInWindow(version)) continue;
    if (!best || (compareVersionStrings(version, best) ?? 0) > 0) best = version;
  }
  return best;
}

export function githubReleasesUrl(page: number): string {
  return `${GITHUB_RELEASES}?per_page=${GITHUB_PER_PAGE}&page=${page}`;
}

async function loadHighestEligibleRelease(): Promise<{
  value: string | null;
  ok: boolean;
}> {
  const collected: Array<{ tag_name?: unknown; prerelease?: unknown }> = [];
  try {
    for (let page = 1; page <= GITHUB_MAX_PAGES; page += 1) {
      const response = await fetch(githubReleasesUrl(page), {
        headers: { accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return { value: null, ok: false };
      const body = (await response.json()) as unknown;
      if (!Array.isArray(body)) return { value: null, ok: false };
      if (body.length === 0) break;
      collected.push(...body);
      if (body.length < GITHUB_PER_PAGE) break;
      if (page === GITHUB_MAX_PAGES) return { value: null, ok: false };
    }
    return { value: pickHighestEligibleRelease(collected), ok: true };
  } catch {
    return { value: null, ok: false };
  }
}

async function readRunning(dataDir: string): Promise<{
  version: string;
  healthy: boolean;
} | null> {
  const attached = await attachIfHealthy(dataDir);
  if (!attached) return null;
  try {
    const response = await fetch(`${attached.url}/global/health`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      version?: unknown;
      healthy?: unknown;
    };
    const version =
      typeof body.version === "string" ? parseExactVersion(body.version) : null;
    if (!version) return null;
    return {
      version,
      healthy: body.healthy === true,
    };
  } catch {
    return null;
  }
}

let platformForTests: NodeJS.Platform | undefined;

export function setPlatformForTests(platform?: NodeJS.Platform): void {
  platformForTests = platform;
}

export function installTreeSupported(): boolean {
  return (platformForTests ?? process.platform) !== "win32";
}

const WINDOWS_INSTALL_MESSAGE =
  "OpenCode install from BB is not supported on Windows because process-group ownership cannot be proven.";

export async function readUpdateStatus(dataDir: string): Promise<UpdateStatus> {
  const blocked = holdBlockMessage();
  const binaryPath = resolveOpenCodeBinary() ?? null;
  const method = binaryPath ? detectUpgradeMethod(binaryPath) : null;
  const diskVersion = binaryPath ? readCliVersion(binaryPath) : null;
  const running = await readRunning(dataDir);
  const latestVersion =
    method === "curl" || method === "npm"
      ? await fetchLatestSupported()
      : null;
  const targetVersion = latestVersion;
  const plan = planInstall({
    binaryPath,
    resolvedPath: binaryPath,
    diskVersion,
    targetVersion,
    method,
  });
  const runningAgrees =
    Boolean(running?.healthy) &&
    Boolean(diskVersion) &&
    compareVersionStrings(running!.version, diskVersion!) === 0;
  const diskVsLatest =
    diskVersion && latestVersion
      ? compareVersionStrings(diskVersion, latestVersion)
      : null;
  const diskAtLeastLatest = diskVsLatest !== null && diskVsLatest >= 0;
  const supportedDisk = Boolean(diskVersion && isVersionInWindow(diskVersion));
  const supportedRunning = Boolean(
    running?.version && isVersionInWindow(running.version),
  );
  const current = Boolean(
    diskAtLeastLatest && runningAgrees && supportedDisk && supportedRunning,
  );
  const versionCanRestart = Boolean(
    diskVersion &&
      parseExactVersion(diskVersion) &&
      isVersionInWindow(diskVersion) &&
      running?.healthy &&
      parseExactVersion(running.version) &&
      (compareVersionStrings(diskVersion, running.version) ?? 0) > 0,
  );
  const lock = readLock(dataDir);
  const ownership = lock
    ? spawnOwnership(lock.pid, lock.port, lock.startedAt)
    : { ok: false as const, error: "No BB-owned OpenCode lock" };
  const guardMsg = launchGuardBlockMessage();
  const canRestart =
    versionCanRestart && !blocked && !guardMsg && ownership.ok;
  const error = blocked
    ? blocked
    : !installTreeSupported()
      ? WINDOWS_INSTALL_MESSAGE
      : !binaryPath
        ? "OpenCode binary not found"
      : !diskVersion
        ? "Disk version is unknown"
        : diskVersion && !isVersionInWindow(diskVersion)
          ? versionSkewMessage(diskVersion)
        : method !== "curl" && method !== "npm"
            ? "Upgrade method is unknown or interactive"
            : !latestVersion
              ? "Latest supported version is unknown"
              : guardMsg
                ? guardMsg
              : versionCanRestart && !ownership.ok
                ? ownership.error
              : !running?.healthy
                ? "Running OpenCode version is unknown"
                : null;
  return {
    binaryPath,
    diskVersion,
    runningVersion: running?.version ?? null,
    latestVersion,
    targetVersion,
    method,
    eligible: plan.ok && installTreeSupported() && !blocked,
    canRestart,
    current: current && !blocked,
    error,
  };
}

function displayCommand(command: string, args: readonly string[]): string {
  return [command, ...args].join(" ");
}

export async function providerInstallationStatus(): Promise<{
  currentVersion: string | null;
  executableName: string;
  executablePath: string | null;
  installAction: {
    command: string;
    kind: "install" | "update";
    label: "Install" | "Update";
  } | null;
  installSource: "external" | "notInstalled" | "npmGlobal";
  installed: boolean;
  latestVersion: string | null;
  minimumSupportedVersion: string | null;
  needsUpdate: boolean;
  npmGlobalPackageVersion: string | null;
  npmPackageName: string | null;
  versionUnsupported: boolean;
}> {
  const resolved = resolveOpenCodeBinary() ?? null;
  const canonical = resolved ? canonicalPath(resolved) : undefined;
  const method = canonical ? detectUpgradeMethod(canonical) : "unknown";
  const diskVersion = canonical ? readCliVersion(canonical) : null;
  const latestVersion =
    method === "curl" || method === "npm"
      ? await fetchLatestSupported()
      : null;
  const plan = planInstall({
    binaryPath: canonical ?? null,
    resolvedPath: resolveOpenCodeBinary() ?? null,
    diskVersion,
    targetVersion: latestVersion,
    method,
  });
  const installed = Boolean(canonical && diskVersion);
  const blocked = holdBlockMessage();
  const allowed = plan.ok && installTreeSupported() && !blocked;
  const args = allowed
    ? (["upgrade", plan.target, "--method", plan.method] as const)
    : null;
  return {
    executableName: "opencode",
    executablePath: canonical ?? null,
    installed,
    installSource:
      !installed ? "notInstalled" : method === "npm" ? "npmGlobal" : "external",
    currentVersion: diskVersion,
    latestVersion,
    minimumSupportedVersion: SERVER_VERSION_MIN,
    npmPackageName: method === "npm" ? "opencode-ai" : null,
    npmGlobalPackageVersion: method === "npm" ? diskVersion : null,
    installAction: null,
    needsUpdate: false,
    versionUnsupported: Boolean(diskVersion && !isVersionInWindow(diskVersion)),
  };
}

export async function providerInstallationRun(
  action: "install" | "update",
): Promise<
  | { available: false; message: string }
  | {
      available: true;
      command: { command: string; args: string[]; displayCommand: string };
      verification:
        | { kind: "version_at_least"; version: string }
        | { kind: "version_changed"; previousVersion: string };
    }
> {
  if (!installTreeSupported()) {
    return { available: false, message: WINDOWS_INSTALL_MESSAGE };
  }
  const blocked = holdBlockMessage();
  if (blocked) {
    return { available: false, message: blocked };
  }
  if (action !== "update") {
    return {
      available: false,
      message: `OpenCode ${action} is not available on this host.`,
    };
  }
  const resolved = resolveOpenCodeBinary() ?? null;
  const canonical = resolved ? canonicalPath(resolved) : undefined;
  const method = canonical ? detectUpgradeMethod(canonical) : "unknown";
  const diskVersion = canonical ? readCliVersion(canonical) : null;
  const latestVersion =
    method === "curl" || method === "npm" ? await fetchLatestSupported() : null;
  const plan = planInstall({
    binaryPath: canonical ?? null,
    resolvedPath: resolveOpenCodeBinary() ?? null,
    diskVersion,
    targetVersion: latestVersion,
    method,
  });
  if (!plan.ok) {
    return { available: false, message: plan.error };
  }
  const wrap = hostWrapEntry();
  if (!wrap) {
    return { available: false, message: "Host wrap entry is not built" };
  }
  const args = [
    wrap,
    "--oc-install-wrap",
    plan.binaryPath,
    "upgrade",
    plan.target,
    "--method",
    plan.method,
  ];
  return {
    available: true,
    command: {
      command: process.execPath,
      args,
      displayCommand: displayCommand(plan.binaryPath, [
        "upgrade",
        plan.target,
        "--method",
        plan.method,
      ]),
    },
    verification: {
      kind: "version_changed",
      previousVersion: diskVersion ?? "",
    },
  };
}

export function hostWrapEntry(): string | null {
  const self = fileURLToPath(import.meta.url);
  if (self.endsWith("/host.js") || self.endsWith("\\host.js")) {
    return existsSync(self) ? self : null;
  }
  const dist = join(process.cwd(), "dist", "host.js");
  if (existsSync(dist) && dist.endsWith(".js")) return dist;
  return null;
}

export function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32") return;
  process.kill(-pgid, signal);
}

export function forwardGroupSignals(pgid: number): () => void {
  const forward = (signal: "SIGINT" | "SIGTERM"): void => {
    try {
      signalProcessGroup(pgid, signal);
    } catch {
      /* ignore */
    }
  };
  const onInt = () => forward("SIGINT");
  const onTerm = () => forward("SIGTERM");
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  return () => {
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
  };
}

export async function runInstallWait(argv: string[]): Promise<number> {
  const gate = argv[0];
  const rest = argv.slice(1);
  if (!gate) return 1;
  const deadline = Date.now() + 15_000;
  while (!existsSync(gate)) {
    if (Date.now() > deadline) return 1;
    await delay(20);
  }
  return runUpgradeChild(rest);
}

function runUpgradeChild(argv: string[]): number {
  const binary = argv[0];
  const verb = argv[1];
  const target = argv[2];
  const methodFlag = argv[3];
  const method = argv[4];
  if (
    !binary ||
    verb !== "upgrade" ||
    !target ||
    methodFlag !== "--method" ||
    (method !== "curl" && method !== "npm")
  ) {
    return 1;
  }
  const result = spawnSync(binary, ["upgrade", target, "--method", method], {
    stdio: "ignore",
  });
  if (result.status !== 0) return result.status ?? 1;
  const after = readCliVersion(binary);
  if (after !== target || !isVersionInWindow(after)) return 1;
  return 0;
}

export async function runInstallWrap(
  argv: string[],
  opts?: { adopt?: typeof adoptExclusive },
): Promise<number> {
  if (!installTreeSupported()) return 1;
  const binary = argv[0];
  const verb = argv[1];
  const target = argv[2];
  const methodFlag = argv[3];
  const method = argv[4];
  if (
    !binary ||
    verb !== "upgrade" ||
    !parseExactVersion(target ?? "") ||
    methodFlag !== "--method" ||
    (method !== "curl" && method !== "npm")
  ) {
    return 1;
  }
  const wrap = hostWrapEntry();
  if (!wrap) return 1;
  const canonical = canonicalPath(binary);
  const resolved = resolveOpenCodeBinary();
  const resolvedCanonical = resolved ? canonicalPath(resolved) : undefined;
  if (!canonical || !resolvedCanonical || canonical !== resolvedCanonical) {
    return 1;
  }
  const token = acquireExclusive("install", target);
  if (!token) return 1;
  const diskNow = readCliVersion(canonical);
  const methodNow = detectUpgradeMethod(canonical);
  const newer = diskNow ? compareVersionStrings(target!, diskNow) : null;
  if (
    !diskNow ||
    methodNow !== method ||
    !isVersionInWindow(target!) ||
    newer === null ||
    newer <= 0
  ) {
    releaseExclusive(token);
    return 1;
  }
  const gate = join(
    process.env.HOME ?? "/tmp",
    ".bb",
    "plugins",
    "opencode",
    `gate.${token}`,
  );
  const waiterArgs = [
    wrap,
    "--oc-install-wait",
    gate,
    canonical,
    "upgrade",
    target!,
    "--method",
    method,
  ];
  let child: ReturnType<typeof spawn> | undefined;
  try {
    child = spawn(process.execPath, waiterArgs, {
      detached: true,
      stdio: "ignore",
    });
  } catch {
    releaseExclusive(token);
    return 1;
  }
  const dropWaiter = (): void => {
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* ignore */
    }
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  };
  if (!child.pid || child.exitCode !== null) {
    dropWaiter();
    releaseExclusive(token);
    return 1;
  }
  const adopt = opts?.adopt ?? adoptExclusive;
  if (
    !adopt(token, child.pid) ||
    child.exitCode !== null ||
    !pidAlive(child.pid)
  ) {
    dropWaiter();
    releaseExclusive(token);
    try {
      unlinkSync(gate);
    } catch {
      /* ignore */
    }
    return 1;
  }
  const pgid = child.pid;
  writeFileSync(gate, "go\n");
  const stopForward = forwardGroupSignals(pgid);
  const code = await new Promise<number>((resolve) => {
    child!.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });
  stopForward();
  try {
    unlinkSync(gate);
  } catch {
    /* ignore */
  }
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline && processGroupAlive(pgid)) {
    await delay(50);
  }
  if (processGroupAlive(pgid)) return 1;
  const after = readCliVersion(canonical);
  releaseExclusive(token);
  if (code !== 0 || after !== target || !isVersionInWindow(after ?? "")) return 1;
  return 0;
}

export function exactPostInstall(args: {
  events: readonly ProviderInstallEvent[];
  expectedPath: string | null;
  expectedTarget: string | null;
  after: UpdateStatus;
}): MutationResult {
  const summarized = summarizeInstallEvents(args.events);
  const expectedPath = args.expectedPath
    ? canonicalPath(args.expectedPath)
    : undefined;
  const afterPath = args.after.binaryPath
    ? canonicalPath(args.after.binaryPath)
    : undefined;
  const disk = args.after.diskVersion;
  if (!summarized.ok) {
    return {
      ok: false,
      error: summarized.error,
      diskVersion: disk,
      targetVersion: args.expectedTarget,
      runningVersion: args.after.runningVersion,
      pendingRestart: false,
    };
  }
  if (!expectedPath || !afterPath || expectedPath !== afterPath) {
    return {
      ok: false,
      error: "Install path changed or could not be resolved",
      diskVersion: disk,
      targetVersion: args.expectedTarget,
      runningVersion: args.after.runningVersion,
      pendingRestart: false,
    };
  }
  if (!args.expectedTarget || disk !== args.expectedTarget) {
    return {
      ok: false,
      error: "Disk version did not match the install target",
      diskVersion: disk,
      targetVersion: args.expectedTarget,
      runningVersion: args.after.runningVersion,
      pendingRestart: false,
    };
  }
  if (!isVersionInWindow(disk)) {
    return {
      ok: false,
      error: versionSkewMessage(disk),
      diskVersion: disk,
      targetVersion: args.expectedTarget,
      runningVersion: args.after.runningVersion,
      pendingRestart: false,
    };
  }
  return {
    ok: true,
    error: null,
    diskVersion: disk,
    targetVersion: args.expectedTarget,
    runningVersion: args.after.runningVersion,
    pendingRestart: false,
  };
}

export function summarizeInstallEvents(
  events: readonly ProviderInstallEvent[],
): { ok: boolean; error: string | null } {
  const failed = events.find((event) => event.type === "error");
  if (failed) {
    return { ok: false, error: failed.message ?? "OpenCode update failed" };
  }
  const completed = [...events].reverse().find((event) => event.type === "completed");
  if (!completed) {
    return { ok: false, error: "OpenCode update did not complete" };
  }
  if (completed.success !== true) {
    return {
      ok: false,
      error: `OpenCode upgrade exited ${completed.exitCode ?? "null"}`,
    };
  }
  return { ok: true, error: null };
}

export async function bbSessionsIdle(
  port: number,
): Promise<true | false | "unknown"> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/session/status`, {
      signal: AbortSignal.timeout(800),
    });
    if (!response.ok) return "unknown";
    const running = runningSessionIdsFromStatus(await response.json());
    if (running.size > 0) return false;
  } catch {
    return "unknown";
  }
  if (listLiveTaskChildren().some((row) => row.running)) return false;
  return true;
}

function refuseRestart(
  error: string,
  status: {
    diskVersion: string | null;
    targetVersion: string | null;
    runningVersion: string | null;
  },
): MutationResult {
  return {
    ok: false,
    error,
    diskVersion: status.diskVersion,
    targetVersion: status.targetVersion,
    runningVersion: status.runningVersion,
    pendingRestart: false,
  };
}

export async function restartToApply(dataDir: string): Promise<MutationResult> {
  try {
    const blocked = holdBlockMessage();
    if (blocked) {
      return refuseRestart(blocked, {
        diskVersion: null,
        targetVersion: null,
        runningVersion: null,
      });
    }
    const restartToken = acquireExclusive("restart");
    if (!restartToken) {
      return refuseRestart("OpenCode install or restart already in progress", {
        diskVersion: null,
        targetVersion: null,
        runningVersion: null,
      });
    }
    try {
        const status = await readUpdateStatus(dataDir);
        const binary = status.binaryPath ? canonicalPath(status.binaryPath) : undefined;
        const expectedDisk = binary ? readCliVersion(binary) : null;
        if (!binary || !expectedDisk || !parseExactVersion(expectedDisk)) {
          return refuseRestart("Disk executable or version is unknown", status);
        }
        if (!isVersionInWindow(expectedDisk)) {
          return refuseRestart(versionSkewMessage(expectedDisk), {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        if (!status.runningVersion) {
          return refuseRestart(
            "No healthy BB-owned OpenCode server is running",
            { ...status, diskVersion: expectedDisk },
          );
        }
        const order = compareVersionStrings(expectedDisk, status.runningVersion);
        if (order === null || order <= 0) {
          return refuseRestart("Disk is not newer than the running server", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        const lock = readLock(dataDir);
        if (!lock) {
          return refuseRestart("No BB-owned OpenCode lock", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        const claim = readLaunchClaim();
        const owned = spawnOwnership(
          lock.pid,
          lock.port,
          lock.startedAt,
          claim?.token,
        );
        if (!owned.ok) {
          return refuseRestart(owned.error, {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        if (!pidAlive(lock.pid)) {
          return refuseRestart("BB OpenCode lock pid is not alive", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        if (!(await portListening(lock.port))) {
          return refuseRestart("BB OpenCode server health is unknown", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        const idle = await bbSessionsIdle(lock.port);
        if (idle !== true) {
          return refuseRestart(
            idle === false
              ? "OpenCode sessions are busy"
              : "BB session idleness is unknown",
            { ...status, diskVersion: expectedDisk },
          );
        }
        const expected: OpenCodeLock = lock;
        const still = readLock(dataDir);
        if (!still || !lockIdentityEqual(still, expected)) {
          return refuseRestart("OpenCode lock was replaced; not signaling the new pid", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        if (!claim?.token) {
          return refuseRestart("OpenCode pid is not a BB-launched serve", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        const stop = await stopServeIf(dataDir, expected, claim.token);
        if (stop !== "stopped") {
          return refuseRestart(
            stop === "replaced"
              ? "OpenCode lock was replaced; not signaling the new pid"
              : stop === "unowned"
                ? (launchGuardBlockMessage() ??
                  "OpenCode pid is not a BB-launched serve")
                : stop === "alive"
                  ? "OpenCode serve did not exit"
                  : "BB OpenCode lock disappeared before restart",
            { ...status, diskVersion: expectedDisk },
          );
        }
        const after = readLock(dataDir);
        if (after && !lockIdentityEqual(after, expected)) {
          return refuseRestart("OpenCode lock was replaced; not spawning over it", {
            ...status,
            diskVersion: expectedDisk,
          });
        }
        const spawned = await attachOrSpawn({
          dataDir,
          binary,
          spawn: true,
          during: "restart",
        });
        const spawnedLock = readLock(dataDir);
        const spawnedClaim = readLaunchClaim();
        const spawnedOwned = spawnedLock
          ? spawnOwnership(
              spawnedLock.pid,
              spawnedLock.port,
              spawnedLock.startedAt,
              spawnedClaim?.token,
            )
          : { ok: false as const, error: "Restarted serve is not the BB-owned spawn identity" };
        if (
          !spawned.startedAt ||
          !spawnedLock ||
          !lockIdentityEqual(spawnedLock, {
            pid: spawned.pid,
            port: spawned.port,
            startedAt: spawned.startedAt,
          }) ||
          !spawnedOwned.ok
        ) {
          return refuseRestart(
            !spawnedOwned.ok
              ? spawnedOwned.error
              : "Restarted serve is not the BB-owned spawn identity",
            {
              ...status,
              diskVersion: expectedDisk,
            },
          );
        }
        const diskAfter = readCliVersion(binary);
        const running = await readRunning(dataDir);
        if (!diskAfter || diskAfter !== expectedDisk) {
          return refuseRestart("Disk version is unknown after restart", {
            diskVersion: diskAfter,
            targetVersion: status.targetVersion,
            runningVersion: running?.version ?? null,
          });
        }
        if (!running?.healthy) {
          return refuseRestart("OpenCode server is unhealthy after restart", {
            diskVersion: diskAfter,
            targetVersion: status.targetVersion,
            runningVersion: running?.version ?? null,
          });
        }
        if (running.version !== diskAfter || !isVersionInWindow(running.version)) {
          return refuseRestart(
            running.version !== diskAfter
              ? "Running version does not match disk after restart"
              : versionSkewMessage(running.version),
            {
              diskVersion: diskAfter,
              targetVersion: status.targetVersion,
              runningVersion: running.version,
            },
          );
        }
        return {
          ok: true,
          error: null,
          diskVersion: diskAfter,
          targetVersion: expectedDisk,
          runningVersion: running.version,
          pendingRestart: false,
        };
    } finally {
      releaseExclusive(restartToken);
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      diskVersion: null,
      targetVersion: null,
      runningVersion: null,
      pendingRestart: false,
    };
  }
}

export function emptyUpdateStatus(error: string): UpdateStatus {
  return {
    binaryPath: null,
    diskVersion: null,
    runningVersion: null,
    latestVersion: null,
    targetVersion: null,
    method: null,
    eligible: false,
    canRestart: false,
    current: false,
    error,
  };
}
