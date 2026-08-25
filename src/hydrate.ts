import {
  closeReasoning,
  closeText,
  createMapDeltaState,
  mapPartDelta,
  type ThreadDelta,
} from "./map-delta.js";

export interface HydrateMessage {
  info: {
    id?: string;
    role?: string;
    agent?: string;
  };
  parts: Array<{
    id?: string;
    type?: string;
    text?: string;
    tool?: string;
    state?: {
      status?: string;
      input?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
      output?: string;
      title?: string;
    };
  }>;
}

/** OpenCode revert is a cursor: keep messages strictly before `revert.messageID`. */
export function revertMessageIdOf(session: { revert?: unknown }): string | undefined {
  const revert = session.revert;
  if (!revert || typeof revert !== "object") return undefined;
  const id = (revert as { messageID?: unknown }).messageID;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function filterMessagesByRevertPoint<T extends { info: { id?: string } }>(
  messages: readonly T[],
  revertMessageId?: string,
): T[] {
  if (!revertMessageId) return [...messages];
  const index = messages.findIndex((message) => message.info.id === revertMessageId);
  if (index < 0) return [...messages];
  return messages.slice(0, index);
}

export function lastUserMessageId(
  messages: readonly HydrateMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i]?.info.id;
    if (messages[i]?.info.role === "user" && typeof id === "string" && id) {
      return id;
    }
  }
  return undefined;
}

/** Inclusive fork/rewind cursor: last OpenCode message this turn should keep. */
export function retainThroughMessageId(
  messages: readonly HydrateMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const id = messages[i]?.info.id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return undefined;
}

export function lastUserAgent(messages: readonly HydrateMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.info.role === "user" && typeof message.info.agent === "string") {
      return message.info.agent;
    }
  }
  return undefined;
}

export function lastAssistantSettled(
  messages: readonly HydrateMessage[],
): boolean {
  const last = messages.at(-1);
  if (!last || last.info.role !== "assistant") return false;
  return last.parts.every((part) => {
    const status = part.state?.status;
    return !status || status === "completed" || status === "error";
  });
}

export function assistantsAfterLastUser(
  messages: readonly HydrateMessage[],
): HydrateMessage[] {
  let lastUser = -1;
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.info.role === "user") lastUser = i;
  }
  if (lastUser < 0) {
    return messages.filter((message) => message.info.role === "assistant");
  }
  return messages
    .slice(lastUser + 1)
    .filter((message) => message.info.role === "assistant");
}

export function completedTurnBoundary(
  messages?: readonly HydrateMessage[],
): ThreadDelta {
  const checkpoint = messages ? retainThroughMessageId(messages) : undefined;
  return {
    kind: "turn.boundary",
    status: "completed",
    ...(checkpoint ? { providerCheckpointId: checkpoint } : {}),
  };
}

function userText(message: HydrateMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
}

export function hydrateDeltas(args: {
  sessionId: string;
  messages: readonly HydrateMessage[];
  skipUserInput?: boolean;
}): ThreadDelta[] {
  const state = createMapDeltaState();
  const deltas: ThreadDelta[] = [{ kind: "session.reset" }];
  let turnOpen = false;
  const closeTurn = (throughIndex: number) => {
    if (!turnOpen) return;
    deltas.push(completedTurnBoundary(args.messages.slice(0, throughIndex + 1)));
    turnOpen = false;
  };
  for (let i = 0; i < args.messages.length; i += 1) {
    const message = args.messages[i];
    if (!message) continue;
    if (message.info.role === "user") {
      closeTurn(i - 1);
      const text = userText(message);
      if (args.skipUserInput) {
        if (text) {
          if (!turnOpen) {
            deltas.push({ kind: "turn.open" });
            turnOpen = true;
          }
          deltas.push({ kind: "input.provider", text });
        }
        continue;
      }
      deltas.push({ kind: "turn.open" });
      turnOpen = true;
      if (text) deltas.push({ kind: "input.provider", text });
      continue;
    }
    if (!turnOpen) {
      deltas.push({ kind: "turn.open" });
      turnOpen = true;
    }
    for (const part of message.parts) {
      const mapped = mapPartDelta({
        state,
        part,
        sessionId: args.sessionId,
      });
      deltas.push(...mapped);
      if (part.type === "text" && part.text) {
        deltas.push(...closeText(part.id ?? "anon", part.text));
      }
      if (part.type === "reasoning" && part.text) {
        deltas.push(...closeReasoning(part.id ?? "anon", part.text));
      }
    }
  }
  if (!args.skipUserInput) closeTurn(args.messages.length - 1);
  return deltas;
}
