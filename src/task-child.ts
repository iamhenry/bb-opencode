/** OpenCode Task child session id, when the tool part has one. */
export function taskChildSessionId(part: {
  tool?: string;
  state?: {
    sessionID?: unknown;
    sessionId?: unknown;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  };
}): string | undefined {
  const tool = part.tool;
  if (tool !== "task" && tool !== "Task") return undefined;
  const state = part.state ?? {};
  const metadata =
    state.metadata && typeof state.metadata === "object" ? state.metadata : {};
  const input =
    state.input && typeof state.input === "object" ? state.input : {};
  for (const value of [
    state.sessionID,
    state.sessionId,
    metadata.sessionID,
    metadata.sessionId,
    input.sessionID,
    input.sessionId,
  ]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

export function taskChildPrompt(part: {
  state?: {
    input?: Record<string, unknown>;
  };
}): string | undefined {
  const input = part.state?.input ?? {};
  for (const key of ["prompt", "description", "task", "query", "message"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function taskDelegationLabel(part: {
  state?: {
    title?: string;
    input?: Record<string, unknown>;
    output?: string;
  };
}): string {
  const input = part.state?.input ?? {};
  const title = part.state?.title?.trim();
  if (title && title !== "Task" && title !== "task") return title;
  for (const key of ["description", "prompt", "subagent_type", "subagentType"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      const text = value.trim();
      return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    }
  }
  return title || "Task";
}

const MAX_TASK_RESULT_SUMMARY_CHARS = 4_096;

function boundedTaskSummary(value: string): string {
  if (value.length <= MAX_TASK_RESULT_SUMMARY_CHARS) return value;
  return `${value.slice(0, MAX_TASK_RESULT_SUMMARY_CHARS)}\n… (truncated)`;
}

/** OpenCode wraps Task output in <task>; BB should show only a bounded result. */
export function taskResultSummary(output: string | undefined): string | undefined {
  if (!output) return undefined;
  const result = output.match(/<task_result>\s*([\s\S]*?)\s*<\/task_result>/i);
  if (result?.[1]) return boundedTaskSummary(result[1].trim());
  const trimmed = output.trim();
  if (trimmed.startsWith("<task")) return undefined;
  return boundedTaskSummary(output);
}
