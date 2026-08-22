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

export function lastUserAgent(messages: readonly HydrateMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.info.role === "user" && typeof message.info.agent === "string") {
      return message.info.agent;
    }
  }
  return undefined;
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
  const checkpoint = messages ? lastUserMessageId(messages) : undefined;
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
}): ThreadDelta[] {
  const state = createMapDeltaState();
  const deltas: ThreadDelta[] = [{ kind: "session.reset" }];
  let turnOpen = false;
  const closeTurn = () => {
    if (!turnOpen) return;
    deltas.push(completedTurnBoundary(args.messages));
    turnOpen = false;
  };
  for (const message of args.messages) {
    if (message.info.role === "user") {
      closeTurn();
      deltas.push({ kind: "turn.open" });
      turnOpen = true;
      const text = userText(message);
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
  closeTurn();
  return deltas;
}
