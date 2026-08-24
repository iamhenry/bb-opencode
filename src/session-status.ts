export type SessionStatusKind = "idle" | "busy" | "retry";

export interface ReadSessionStatus {
  kind?: SessionStatusKind;
  attempt?: number;
  message?: string;
}

export function readSessionStatus(properties: unknown): ReadSessionStatus {
  const raw = unwrapStatus(properties);
  if (!raw) return {};
  if (raw === "idle" || raw === "busy" || raw === "retry") {
    return { kind: raw };
  }
  if (typeof raw !== "object") return {};
  const record = raw as {
    type?: unknown;
    attempt?: unknown;
    message?: unknown;
  };
  if (
    record.type !== "idle" &&
    record.type !== "busy" &&
    record.type !== "retry"
  ) {
    return {};
  }
  return {
    kind: record.type,
    attempt: typeof record.attempt === "number" ? record.attempt : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  };
}

function unwrapStatus(properties: unknown): unknown {
  if (properties === "idle" || properties === "busy" || properties === "retry") {
    return properties;
  }
  if (!properties || typeof properties !== "object") return undefined;
  const record = properties as { status?: unknown };
  return record.status ?? properties;
}

export function retryKey(args: {
  sessionId: string;
  messageId?: string;
  attempt?: number;
}): string {
  return `${args.sessionId}:${args.messageId ?? "-"}:${args.attempt ?? 0}`;
}

export function retryFromPart(part: unknown): {
  attempt?: number;
  message: string;
  messageId?: string;
} | undefined {
  if (!part || typeof part !== "object") return undefined;
  const record = part as {
    type?: unknown;
    attempt?: unknown;
    messageID?: unknown;
    error?: unknown;
  };
  if (record.type !== "retry") return undefined;
  return {
    attempt: typeof record.attempt === "number" ? record.attempt : undefined,
    messageId: typeof record.messageID === "string" ? record.messageID : undefined,
    message: describeSessionError(record.error).message,
  };
}

export function describeSessionError(error: unknown): {
  status: "failed" | "interrupted";
  message: string;
} {
  if (!error || typeof error !== "object") {
    return { status: "failed", message: "OpenCode session error" };
  }
  const record = error as {
    name?: unknown;
    data?: { message?: unknown; providerID?: unknown };
    message?: unknown;
  };
  const name = typeof record.name === "string" ? record.name : "";
  const dataMessage =
    typeof record.data?.message === "string" ? record.data.message : undefined;
  const topMessage = typeof record.message === "string" ? record.message : undefined;
  const text = dataMessage || topMessage;

  if (name === "MessageAbortedError") {
    return { status: "interrupted", message: text || "Stopped" };
  }
  if (name === "ProviderAuthError") {
    const provider =
      typeof record.data?.providerID === "string"
        ? record.data.providerID
        : "provider";
    return {
      status: "failed",
      message: text
        ? `OpenCode auth failed (${provider}): ${text}`
        : `OpenCode auth failed (${provider})`,
    };
  }
  if (name === "MessageOutputLengthError") {
    return {
      status: "failed",
      message: text || "OpenCode hit the output length limit",
    };
  }
  if (text) return { status: "failed", message: text };
  if (name) return { status: "failed", message: name };
  return { status: "failed", message: "OpenCode session error" };
}

export function bashCommandOutput(state: {
  output?: string;
  metadata?: Record<string, unknown>;
} | undefined): string {
  if (!state) return "";
  const metadata = state.metadata;
  for (const key of ["output", "stdout", "preview"] as const) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return typeof state.output === "string" ? state.output : "";
}

export function bashCommandCwd(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of ["workdir", "cwd", "directory"] as const) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return "";
}
