import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export type ExclusiveKind = "install" | "restart";

export interface ExclusiveHold {
  token: string;
  pid: number;
  kind: ExclusiveKind;
  target?: string;
  phase?: "pending" | "active";
  pgid?: number;
}

interface HoldState {
  exclusive: ExclusiveHold | null;
  starts: Record<string, number>;
}

const MUTEX_FILE = "opencode.hold.mutex";
const STATE_FILE = "opencode.hold.json";

function holdDir(): string {
  const dir = join(process.env.HOME ?? "/tmp", ".bb", "plugins", "opencode");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function mutexPath(): string {
  return join(holdDir(), MUTEX_FILE);
}

function statePath(): string {
  return join(holdDir(), STATE_FILE);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function processGroupAlive(pgid: number): boolean {
  if (process.platform === "win32") return pidAlive(pgid);
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

function emptyState(): HoldState {
  return { exclusive: null, starts: {} };
}

function newToken(): string {
  return `${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readState(): HoldState | "corrupt" {
  if (!existsSync(statePath())) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "corrupt";
    }
    const record = parsed as {
      exclusive?: unknown;
      starts?: unknown;
    };
    const starts: Record<string, number> = {};
    if (record.starts && typeof record.starts === "object" && !Array.isArray(record.starts)) {
      for (const [token, pid] of Object.entries(record.starts as Record<string, unknown>)) {
        if (typeof pid === "number" && pidAlive(pid)) starts[token] = pid;
      }
    } else if (record.starts !== undefined && record.starts !== null) {
      return "corrupt";
    }
    let exclusive: ExclusiveHold | null = null;
    if (record.exclusive && typeof record.exclusive === "object") {
      const ex = record.exclusive as {
        token?: unknown;
        pid?: unknown;
        kind?: unknown;
        target?: unknown;
        phase?: unknown;
        pgid?: unknown;
      };
      if (
        typeof ex.token !== "string" ||
        typeof ex.pid !== "number" ||
        (ex.kind !== "install" && ex.kind !== "restart")
      ) {
        return "corrupt";
      }
      const phase =
        ex.phase === "pending" || ex.phase === "active" ? ex.phase : "active";
      const pgid = typeof ex.pgid === "number" ? ex.pgid : undefined;
      const keepPendingDead = phase === "pending" && !pidAlive(ex.pid);
      const keepActiveTree =
        phase === "active" && pgid !== undefined && processGroupAlive(pgid);
      if (pidAlive(ex.pid) || keepPendingDead || keepActiveTree) {
        exclusive = {
          token: ex.token,
          pid: ex.pid,
          kind: ex.kind,
          target: typeof ex.target === "string" ? ex.target : undefined,
          phase,
          pgid,
        };
      }
    } else if (record.exclusive !== undefined && record.exclusive !== null) {
      return "corrupt";
    }
    return { exclusive, starts };
  } catch {
    return "corrupt";
  }
}

function writeStateAtomic(state: HoldState): void {
  const path = statePath();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state)}\n`);
  renameSync(tmp, path);
}

function acquireMutex(): boolean {
  try {
    writeFileSync(mutexPath(), `${process.pid}\n`, { flag: "wx" });
    return true;
  } catch {
    if (!existsSync(mutexPath())) return false;
    try {
      const pid = Number(readFileSync(mutexPath(), "utf8").trim());
      if (Number.isFinite(pid) && pidAlive(pid)) return false;
      unlinkSync(mutexPath());
    } catch {
      return false;
    }
    try {
      writeFileSync(mutexPath(), `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch {
      return false;
    }
  }
}

function releaseMutex(): void {
  try {
    unlinkSync(mutexPath());
  } catch {
    /* ignore */
  }
}

function withMutex<T>(fn: (state: HoldState) => T): T | undefined {
  if (!acquireMutex()) return undefined;
  try {
    const state = readState();
    if (state === "corrupt") return undefined;
    const result = fn(state);
    writeStateAtomic(state);
    return result;
  } catch {
    return undefined;
  } finally {
    releaseMutex();
  }
}

export const HOLD_FILE_NAME = STATE_FILE;

export type HoldView =
  | { status: "clear" }
  | { status: "live"; kind: ExclusiveKind }
  | { status: "ambiguous"; reason: "corrupt" | "pending-dead" };

export function inspectHold(): HoldView {
  const state = readState();
  if (state === "corrupt") return { status: "ambiguous", reason: "corrupt" };
  const ex = state.exclusive;
  if (!ex) return { status: "clear" };
  if (ex.phase === "pending" && !pidAlive(ex.pid)) {
    return { status: "ambiguous", reason: "pending-dead" };
  }
  if (
    pidAlive(ex.pid) ||
    (ex.phase === "active" && ex.pgid !== undefined && processGroupAlive(ex.pgid))
  ) {
    return { status: "live", kind: ex.kind };
  }
  return { status: "clear" };
}

export function holdBlockMessage(): string | null {
  const view = inspectHold();
  if (view.status === "live") {
    return `OpenCode ${view.kind} already in progress`;
  }
  if (view.status === "ambiguous") {
    return `OpenCode hold is stuck. Confirm no updater or process group is alive, then remove ${HOLD_FILE_NAME} from the plugin data directory.`;
  }
  if (startGuardsActive()) return "OpenCode start already in progress";
  return null;
}

export function exclusiveKind(): ExclusiveKind | null {
  const view = inspectHold();
  return view.status === "live" ? view.kind : null;
}

export function exclusiveToken(): string | undefined {
  const state = readState();
  if (state === "corrupt") return undefined;
  return state.exclusive?.token;
}

export function startGuardsActive(): boolean {
  const state = readState();
  if (state === "corrupt") return true;
  return Object.keys(state.starts).length > 0;
}

export function acquireExclusive(
  kind: ExclusiveKind,
  target?: string,
): string | null {
  const token = newToken();
  const result = withMutex((state) => {
    if (state.exclusive) return false;
    if (Object.keys(state.starts).length > 0) return false;
    state.exclusive = {
      token,
      pid: process.pid,
      kind,
      target,
      phase: "pending",
    };
    return true;
  });
  return result === true ? token : null;
}

export function adoptExclusive(token: string, pid: number): boolean {
  const result = withMutex((state) => {
    if (!state.exclusive || state.exclusive.token !== token) return false;
    if (state.exclusive.phase !== "pending") return false;
    state.exclusive.pid = pid;
    state.exclusive.pgid = pid;
    state.exclusive.phase = "active";
    return true;
  });
  return result === true;
}

export function releaseExclusive(token: string): boolean {
  const result = withMutex((state) => {
    if (!state.exclusive || state.exclusive.token !== token) return false;
    state.exclusive = null;
    return true;
  });
  return result === true;
}

export function acquireStartGuard(): string | null {
  const token = `s-${newToken()}`;
  const result = withMutex((state) => {
    if (state.exclusive) return false;
    state.starts[token] = process.pid;
    return true;
  });
  return result === true ? token : null;
}

export function releaseStartGuard(token: string): void {
  withMutex((state) => {
    delete state.starts[token];
  });
}

export function resetHoldForTests(): void {
  try {
    unlinkSync(mutexPath());
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(statePath());
  } catch {
    /* ignore */
  }
  try {
    unlinkSync(`${statePath()}.${process.pid}.tmp`);
  } catch {
    /* ignore */
  }
}
