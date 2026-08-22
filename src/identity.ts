export const PROVIDER_ID = "opencode" as const;
export const PROVIDER_DISPLAY_NAME = "OpenCode";
export const SDK_PIN = "1.18.21";
export const SERVER_VERSION_MIN = "1.18.0";
export const SERVER_VERSION_MAX_EXCLUSIVE = "1.19.0";

const SYSTEM_AGENT_NAMES = new Set(["title", "compaction", "summary"]);

export function isVersionInWindow(version: string): boolean {
  const parsed = parseSemver(version);
  const min = parseSemver(SERVER_VERSION_MIN);
  const max = parseSemver(SERVER_VERSION_MAX_EXCLUSIVE);
  if (!parsed || !min || !max) return false;
  return compareSemver(parsed, min) >= 0 && compareSemver(parsed, max) < 0;
}

export function versionSkewMessage(serverVersion: string): string {
  return `OpenCode server ${serverVersion} is outside the pinned window ${SERVER_VERSION_MIN}–<${SERVER_VERSION_MAX_EXCLUSIVE} (SDK ${SDK_PIN}).`;
}

export function isSystemAgentName(name: string): boolean {
  return SYSTEM_AGENT_NAMES.has(name);
}

function parseSemver(version: string): [number, number, number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(
  left: [number, number, number],
  right: [number, number, number],
): number {
  for (let i = 0; i < 3; i += 1) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}
