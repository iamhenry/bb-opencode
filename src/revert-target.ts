export interface RevertTargetMessage {
  info: { id?: string; role?: string };
}

export interface RevertTimelineMessage {
  id?: string;
  kind?: string;
  role?: string;
  turnId?: string | null;
  children?: readonly RevertTimelineMessage[] | null;
}

export interface RevertTurnBoundary {
  type?: string;
  scope?: { kind?: string; turnId?: string };
  data?: unknown;
}

function findTimelineMessage(
  rows: readonly RevertTimelineMessage[],
  messageId: string,
): RevertTimelineMessage | undefined {
  for (const row of rows) {
    if (row.id === messageId && row.kind === "conversation") return row;
    const nested = row.children && findTimelineMessage(row.children, messageId);
    if (nested) return nested;
  }
  return undefined;
}

function followingTurnId(
  rows: readonly RevertTimelineMessage[],
  messageId: string,
): string | undefined {
  const index = rows.findIndex(
    (row) => row.id === messageId && row.kind === "conversation",
  );
  if (index < 0) {
    for (const row of rows) {
      const nested = row.children && followingTurnId(row.children, messageId);
      if (nested) return nested;
    }
    return undefined;
  }
  // A thread's opening prompt carries no turnId; its turn is the next row.
  for (const row of rows.slice(index + 1)) {
    if (row.kind === "conversation" && row.role === "user") return undefined;
    if (typeof row.turnId === "string" && row.turnId) return row.turnId;
  }
  return undefined;
}

export function revertTurnIdForMessage(
  rows: readonly RevertTimelineMessage[],
  messageId: string,
): string | undefined {
  const message = findTimelineMessage(rows, messageId);
  if (!message || message.role !== "user") {
    const turnId = message?.turnId;
    return typeof turnId === "string" && turnId ? turnId : undefined;
  }
  if (typeof message.turnId === "string" && message.turnId) return message.turnId;
  return followingTurnId(rows, messageId);
}

export function resolveRevertCheckpointId(args: {
  rows: readonly RevertTimelineMessage[];
  messageId: string;
  boundaries: readonly RevertTurnBoundary[];
}): string | undefined {
  const turnId = revertTurnIdForMessage(args.rows, args.messageId);
  if (!turnId) return undefined;
  const boundaries = args.boundaries.filter(
    (event) =>
      event.type === "turn/completed" &&
      event.scope?.kind === "turn" &&
      event.scope.turnId === turnId,
  );
  if (boundaries.length !== 1) return undefined;
  const data = boundaries[0]?.data;
  if (!data || typeof data !== "object") return undefined;
  const checkpoint = (data as { providerCheckpointId?: unknown })
    .providerCheckpointId;
  return typeof checkpoint === "string" && checkpoint ? checkpoint : undefined;
}

/** Pick the OpenCode message `session.revert` should target. */
export function resolveRevertMessageId(args: {
  messages: readonly RevertTargetMessage[];
  role?: "user" | "assistant";
  text?: string;
  messageID?: string;
}): string | undefined {
  if (!args.messageID) return undefined;
  const matches = args.messages.filter((message) => message.info.id === args.messageID);
  if (matches.length !== 1) return undefined;
  const target = matches[0];
  if (!target || (args.role && args.role !== target.info.role)) return undefined;
  if (target.info.role === "user") return args.messageID;
  if (target.info.role !== "assistant") return undefined;

  const index = args.messages.indexOf(target);
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const message = args.messages[cursor];
    if (message?.info.role === "user" && message.info.id) {
      return args.messages.filter((entry) => entry.info.id === message.info.id).length === 1
        ? message.info.id
        : undefined;
    }
  }
  return undefined;
}
