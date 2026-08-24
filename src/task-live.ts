import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sharedLockDir } from "./process.js";

const FILE_NAME = "task-live.json";
const STALE_MS = 45_000;

export interface LiveTaskChild {
  parentThreadId?: string;
  parentSessionId: string;
  childSessionId: string;
  title: string | null;
  running: boolean;
  boundThreadId?: string;
  updatedAt: number;
}

function livePath(): string {
  const override = process.env.OC_TASK_LIVE_PATH;
  if (override) return override;
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, FILE_NAME);
}

function boundPath(): string {
  const override = process.env.OC_TASK_BOUND_PATH;
  if (override) return override;
  const dir = sharedLockDir();
  mkdirSync(dir, { recursive: true });
  return join(dir, "task-bound.json");
}

function readBound(): Record<string, string> {
  const path = boundPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function boundThreadForTaskChild(childSessionId: string): string | null {
  const id = readBound()[childSessionId];
  return typeof id === "string" && id.length > 0 ? id : null;
}

export function rememberBoundTaskChild(
  childSessionId: string,
  boundThreadId: string,
): void {
  const next = readBound();
  next[childSessionId] = boundThreadId;
  writeFileSync(boundPath(), `${JSON.stringify(next)}\n`);
  const rows = readAll().map((row) =>
    row.childSessionId === childSessionId ? { ...row, boundThreadId } : row,
  );
  writeAll(rows);
}

function readAll(): LiveTaskChild[] {
  const path = livePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as LiveTaskChild[]) : [];
  } catch {
    return [];
  }
}

function writeAll(rows: LiveTaskChild[]): void {
  writeFileSync(livePath(), `${JSON.stringify(rows)}\n`);
}

export function noteLiveTaskChild(row: {
  parentThreadId?: string;
  parentSessionId: string;
  childSessionId: string;
  title?: string | null;
  running: boolean;
  now?: number;
}): LiveTaskChild[] {
  const now = row.now ?? Date.now();
  const previous = readAll().find((item) => item.childSessionId === row.childSessionId);
  const next = readAll().filter(
    (item) =>
      item.childSessionId !== row.childSessionId &&
      now - item.updatedAt < STALE_MS,
  );
  next.push({
    parentThreadId: row.parentThreadId,
    parentSessionId: row.parentSessionId,
    childSessionId: row.childSessionId,
    title: row.title ?? null,
    running: row.running,
    boundThreadId: previous?.boundThreadId ?? boundThreadForTaskChild(row.childSessionId) ?? undefined,
    updatedAt: now,
  });
  writeAll(next);
  return next;
}

export function listLiveTaskChildren(parentSessionId?: string, now = Date.now()): LiveTaskChild[] {
  return readAll().filter((row) => {
    if (now - row.updatedAt >= STALE_MS) return false;
    if (parentSessionId && row.parentSessionId !== parentSessionId) return false;
    return true;
  });
}
