// import { appendFileSync } from "node:fs";

const MAX = 80;
const lines: string[] = [];
// Disabled: file tracing can capture local paths and session data.
// const traceFile = process.env.BB_OPENCODE_TRACE;

export function debugLog(message: string): void {
  lines.push(message);
  if (lines.length > MAX) lines.shift();
  // if (traceFile) {
  //   try {
  //     appendFileSync(traceFile, `${new Date().toISOString()} ${message}\n`);
  //   } catch {
  //     /* tracing is best-effort */
  //   }
  // }
}

export function recentDebugLog(): string[] {
  return [...lines];
}

export function resetDebugLogForTests(): void {
  lines.length = 0;
}
