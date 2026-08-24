const MAX = 80;
const lines: string[] = [];

export function debugLog(message: string): void {
  lines.push(message);
  if (lines.length > MAX) lines.shift();
}

export function recentDebugLog(): string[] {
  return [...lines];
}

export function resetDebugLogForTests(): void {
  lines.length = 0;
}
