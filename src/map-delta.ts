import { isBashToolName } from "./permissions/map.js";

export interface ThreadDelta {
  kind: string;
  [key: string]: unknown;
}

export interface MapDeltaState {
  unknownTally: Map<string, number>;
  itemKeys: Map<string, { channel: string } | { providerItemId: string }>;
  emittedText: Map<string, string>;
  openedItems: Map<string, "command" | "tool">;
  closedItems: Set<string>;
  lastSnapshots: Map<string, string>;
}

export function createMapDeltaState(): MapDeltaState {
  return {
    unknownTally: new Map(),
    itemKeys: new Map(),
    emittedText: new Map(),
    openedItems: new Map(),
    closedItems: new Set(),
    lastSnapshots: new Map(),
  };
}

function nextTextChunk(
  state: MapDeltaState,
  partId: string,
  full: string | undefined,
  incremental?: string,
): string {
  const previous = state.emittedText.get(partId) ?? "";
  const next =
    typeof full === "string" && full.length > 0
      ? full
      : incremental
        ? `${previous}${incremental}`
        : previous;
  const chunk =
    incremental && (!full || full === `${previous}${incremental}`)
      ? incremental
      : next.slice(previous.length);
  if (next.length > 0) state.emittedText.set(partId, next);
  return chunk;
}

export function tallyUnknown(state: MapDeltaState, type: string): void {
  state.unknownTally.set(type, (state.unknownTally.get(type) ?? 0) + 1);
}

export function formatUnknownTally(state: MapDeltaState): string {
  return [...state.unknownTally.entries()]
    .map(([type, count]) => `${type}=${count}`)
    .join(" ");
}

interface PartLike {
  id?: string;
  type?: string;
  text?: string;
  tool?: string;
  sessionID?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    output?: string;
    error?: string;
    title?: string;
  };
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function coreToolItem(
  toolName: string,
  part: PartLike,
): Record<string, unknown> {
  const input = part.state?.input;
  const metadata =
    part.state?.metadata && typeof part.state.metadata === "object"
      ? (part.state.metadata as Record<string, unknown>)
      : undefined;
  if (toolName === "read" || toolName === "read_file") {
    return {
      type: "fileRead",
      path:
        stringField(input, "filePath") ??
        stringField(input, "path") ??
        "unknown",
    };
  }
  if (toolName === "grep" || toolName === "glob" || toolName === "list") {
    const query =
      stringField(input, "pattern") ?? stringField(input, "query") ?? "";
    if (query || toolName === "list") {
      return {
        type: "search",
        mode:
          toolName === "glob" ? "path" : toolName === "list" ? "list" : "content",
        query,
        path: stringField(input, "path"),
      };
    }
  }
  if (toolName === "task" || toolName === "Task") {
    const child =
      stringField(part.state as Record<string, unknown> | undefined, "sessionID") ??
      stringField(part.state as Record<string, unknown> | undefined, "sessionId") ??
      stringField(metadata, "sessionID") ??
      stringField(metadata, "sessionId") ??
      part.id ??
      part.callID ??
      "task";
    return {
      type: "delegation",
      childRef: child,
      label: part.state?.title || "Task",
      background: false,
      summary:
        typeof part.state?.output === "string" ? part.state.output : undefined,
    };
  }
  return {
    type: "tool",
    tool: toolName,
    args: input,
    result: part.state?.output,
  };
}

export function mapPartDelta(args: {
  state: MapDeltaState;
  part: PartLike;
  sessionId: string;
  delta?: string;
}): ThreadDelta[] {
  const part = args.part;
  const type = part.type ?? "unknown";
  if (type === "text" || type === "text-delta") {
    const partId = part.id ?? "anon";
    const chunk = nextTextChunk(args.state, partId, part.text, args.delta);
    if (!chunk) return [];
    return [
      {
        kind: "item.textDelta",
        key: { channel: `text:${partId}` },
        channel: "agentMessage",
        text: chunk,
      },
    ];
  }
  if (type === "reasoning" || type === "reasoning-delta") {
    const partId = part.id ?? "anon";
    const chunk = nextTextChunk(
      args.state,
      `reasoning:${partId}`,
      part.text,
      args.delta,
    );
    if (!chunk) return [];
    return [
      {
        kind: "item.textDelta",
        key: { channel: `reasoning:${partId}` },
        channel: "reasoningText",
        text: chunk,
      },
    ];
  }
  if (type === "tool") {
    const toolName = part.tool ?? "tool";
    const itemId = part.id ?? part.callID ?? toolName;
    if (args.state.closedItems.has(itemId)) return [];
    const key = { providerItemId: itemId };
    args.state.itemKeys.set(itemId, key);
    const alreadyOpen = args.state.openedItems.has(itemId);
    const kind = isBashToolName(toolName) ? "command" : "tool";
    if (!alreadyOpen) args.state.openedItems.set(itemId, kind);
    const finished =
      part.state?.status === "completed" || part.state?.status === "error";
    if (isBashToolName(toolName)) {
      const command =
        (typeof part.state?.input?.command === "string" &&
          part.state.input.command) ||
        toolName;
      const output =
        (typeof part.state?.metadata?.output === "string" &&
          part.state.metadata.output) ||
        part.state?.output ||
        "";
      const deltas: ThreadDelta[] = [];
      if (!alreadyOpen) {
        deltas.push({
          kind: "item.open",
          key,
          item: {
            type: "command",
            command,
            cwd: "",
            aggregatedOutput: output,
          },
        });
      }
      if (output && args.state.lastSnapshots.get(itemId) !== output) {
        args.state.lastSnapshots.set(itemId, output);
        deltas.push({
          kind: "command.outputSnapshot",
          key,
          text: output,
        });
      }
      if (finished) {
        args.state.closedItems.add(itemId);
        deltas.push({
          kind: "item.close",
          key,
          status: part.state?.status === "error" ? "failed" : "completed",
          item: {
            type: "command",
            command,
            cwd: "",
            aggregatedOutput: output,
          },
        });
      }
      return deltas;
    }
    const presentation = {
      label: {
        pending: part.state?.title || `Running ${toolName}`,
        completed: part.state?.title || `Ran ${toolName}`,
      },
      icon: { glyph: toolName === "task" ? "Bot" : "Wrench" },
    };
    const item = coreToolItem(toolName, part);
    const deltas: ThreadDelta[] = [];
    if (!alreadyOpen) {
      deltas.push({
        kind: "item.open",
        key,
        item,
        presentation,
      });
    }
    if (finished) {
      args.state.closedItems.add(itemId);
      deltas.push({
        kind: "item.close",
        key,
        status: part.state?.status === "error" ? "failed" : "completed",
        item: {
          ...item,
          ...(item.type === "tool"
            ? {
                result: part.state?.output,
                error:
                  part.state?.status === "error"
                    ? String(part.state.error ?? part.state.output ?? "error")
                    : undefined,
              }
            : {}),
        },
        presentation,
      });
    }
    return deltas;
  }
  tallyUnknown(args.state, type);
  return [];
}

/** Map OpenCode 1.18 `session.next.*` SSE into the same deltas as part snapshots. */
export function mapSessionNextEvent(args: {
  type: string;
  properties?: unknown;
  state: MapDeltaState;
  sessionId: string;
}): ThreadDelta[] {
  const record =
    args.properties && typeof args.properties === "object"
      ? (args.properties as Record<string, unknown>)
      : {};
  if (args.type === "session.next.text.delta") {
    const id = typeof record.textID === "string" ? record.textID : undefined;
    const delta = typeof record.delta === "string" ? record.delta : undefined;
    if (!id || !delta) return [];
    return mapPartDelta({
      state: args.state,
      sessionId: args.sessionId,
      part: { id, type: "text" },
      delta,
    });
  }
  if (args.type === "session.next.text.ended") {
    const id = typeof record.textID === "string" ? record.textID : undefined;
    const text = typeof record.text === "string" ? record.text : "";
    if (!id) return [];
    const leftover = mapPartDelta({
      state: args.state,
      sessionId: args.sessionId,
      part: { id, type: "text", text },
    });
    return [...leftover, ...closeText(id, text)];
  }
  if (args.type === "session.next.reasoning.delta") {
    const id =
      typeof record.reasoningID === "string" ? record.reasoningID : undefined;
    const delta = typeof record.delta === "string" ? record.delta : undefined;
    if (!id || !delta) return [];
    return mapPartDelta({
      state: args.state,
      sessionId: args.sessionId,
      part: { id, type: "reasoning" },
      delta,
    });
  }
  if (args.type === "session.next.tool.called") {
    const id = typeof record.callID === "string" ? record.callID : undefined;
    const tool = typeof record.tool === "string" ? record.tool : "tool";
    if (!id) return [];
    const input =
      record.input && typeof record.input === "object"
        ? (record.input as Record<string, unknown>)
        : undefined;
    return mapPartDelta({
      state: args.state,
      sessionId: args.sessionId,
      part: {
        id,
        type: "tool",
        tool,
        callID: id,
        state: { status: "running", input },
      },
    });
  }
  if (
    args.type === "session.next.tool.success" ||
    args.type === "session.next.tool.error"
  ) {
    const id = typeof record.callID === "string" ? record.callID : undefined;
    if (!id) return [];
    const output =
      typeof record.result === "string"
        ? record.result
        : typeof record.output === "string"
          ? record.output
          : undefined;
    return mapPartDelta({
      state: args.state,
      sessionId: args.sessionId,
      part: {
        id,
        type: "tool",
        tool: typeof record.tool === "string" ? record.tool : "tool",
        callID: id,
        state: {
          status: args.type.endsWith("error") ? "error" : "completed",
          output,
          error:
            args.type.endsWith("error") && typeof record.error === "string"
              ? record.error
              : undefined,
        },
      },
    });
  }
  return [];
}

export function closeText(partId: string, text: string): ThreadDelta[] {
  return [
    {
      kind: "item.textClose",
      key: { channel: `text:${partId}` },
      channel: "agentMessage",
      text,
    },
  ];
}

export function closeReasoning(partId: string, text: string): ThreadDelta[] {
  return [
    {
      kind: "item.textClose",
      key: { channel: `reasoning:${partId}` },
      channel: "reasoningText",
      text,
    },
  ];
}

export function closeOpenedItems(state: MapDeltaState): ThreadDelta[] {
  const deltas: ThreadDelta[] = [];
  for (const [itemId, kind] of state.openedItems) {
    deltas.push({
      kind: "item.close",
      key: { providerItemId: itemId },
      status: "interrupted",
      item:
        kind === "command"
          ? { type: "command", command: "", cwd: "", aggregatedOutput: "" }
          : { type: "tool", tool: "tool" },
    });
  }
  state.openedItems.clear();
  return deltas;
}
