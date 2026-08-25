import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  parsePermissionMode,
  type LivePermissionMode,
} from "./permission-mode.js";

function liveModeDir(dataDir: string): string {
  return join(dataDir, "live-permission-mode");
}

function liveModePath(dataDir: string, threadId: string): string {
  return join(liveModeDir(dataDir), encodeURIComponent(threadId));
}

export function writeLivePermissionMode(
  dataDir: string,
  threadId: string,
  mode: LivePermissionMode,
): void {
  if (!dataDir || !threadId) return;
  mkdirSync(liveModeDir(dataDir), { recursive: true });
  writeFileSync(liveModePath(dataDir, threadId), mode);
}

export function readLivePermissionMode(
  dataDir: string,
  threadId: string,
): LivePermissionMode | undefined {
  if (!dataDir || !threadId) return undefined;
  try {
    return parsePermissionMode(
      readFileSync(liveModePath(dataDir, threadId), "utf8").trim(),
    );
  } catch {
    return undefined;
  }
}

export function clearLivePermissionModes(dataDir: string): void {
  if (!dataDir) return;
  rmSync(liveModeDir(dataDir), { recursive: true, force: true });
}
