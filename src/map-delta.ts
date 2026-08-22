import { isBashToolName } from "./permissions/map.js";

export interface ThreadDelta {
  kind: string;
  [key: string]: unknown;
}

export interface MapDeltaState {
  unknownTally: Map<string, number>;
  itemKeys: Map<string, { channel: string } | { id: string }>;
}

export function createMapDeltaState(): MapDeltaState {
  return { unknownTally: new Map(), itemKeys: new Map() };
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
    title?: string;
  };
}

export function mapPartDelta(args: {
  state: MapDeltaState;
  part: PartLike;
  sessionId: string;
}): ThreadDelta[] {
  const part = args.part;
  const type = part.type ?? "unknown";
  if (type === "text" || type === "text-delta") {
    const key = { channel: `text:${part.id ?? "anon"}` };
    return [
      {
        kind: "item.textDelta",
        key,
        channel: "agentMessage",
        text: part.text ?? "",
      },
    ];
  }
  if (type === "reasoning" || type === "reasoning-delta") {
    const key = { channel: `reasoning:${part.id ?? "anon"}` };
    return [
      {
        kind: "item.textDelta",
        key,
        channel: "reasoningText",
        text: part.text ?? "",
      },
    ];
  }
  if (type === "tool") {
    const toolName = part.tool ?? "tool";
    const itemId = part.id ?? part.callID ?? toolName;
    const key = { id: itemId };
    args.state.itemKeys.set(itemId, key);
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
      const deltas: ThreadDelta[] = [
        {
          kind: "item.open",
          key,
          item: {
            type: "command",
            command,
            cwd: "",
            aggregatedOutput: output,
          },
        },
      ];
      if (output) {
        deltas.push({
          kind: "command.outputSnapshot",
          key,
          output,
        });
      }
      if (part.state?.status === "completed" || part.state?.status === "error") {
        deltas.push({
          kind: "item.close",
          key,
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
    const deltas: ThreadDelta[] = [
      {
        kind: "item.open",
        key,
        item: {
          type: "tool",
          tool: toolName,
          args: part.state?.input,
          result: part.state?.output,
        },
        presentation,
      },
    ];
    if (part.state?.status === "completed" || part.state?.status === "error") {
      deltas.push({
        kind: "item.close",
        key,
        item: {
          type: "tool",
          tool: toolName,
          args: part.state?.input,
          result: part.state?.output,
          error:
            part.state.status === "error"
              ? String(part.state.output ?? "error")
              : undefined,
        },
        presentation,
      });
    }
    return deltas;
  }
  tallyUnknown(args.state, type);
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
