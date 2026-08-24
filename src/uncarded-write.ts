import { isFileChangeToolName } from "./file-change.js";

export const UNCARDED_WRITE_POLLS = 3;

export function runningFileToolName(
  messages: Array<{ parts?: Array<Record<string, unknown>> }>,
): string | undefined {
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      const name =
        typeof part.tool === "string"
          ? part.tool
          : typeof part.name === "string"
            ? part.name
            : "";
      if (!name || !isFileChangeToolName(name)) continue;
      const state = part.state;
      const status =
        state && typeof state === "object"
          ? (state as { status?: unknown }).status
          : part.status;
      if (status === "running" || status === "pending") return name;
    }
  }
  return undefined;
}

export function nextUncardedWriteStreak(args: {
  runningTool?: string;
  pendingAskCount: number;
  hasCard: boolean;
  streak: number;
}): { streak: number; giveUp: boolean } {
  if (!args.runningTool || args.pendingAskCount > 0 || args.hasCard) {
    return { streak: 0, giveUp: false };
  }
  const streak = args.streak + 1;
  return { streak, giveUp: streak >= UNCARDED_WRITE_POLLS };
}
