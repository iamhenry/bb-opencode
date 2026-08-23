import type { ThreadDelta } from "./map-delta.js";

export type TokenBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

function emptyUsage(): TokenBreakdown {
  return {
    totalTokens: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
  };
}

function addUsage(left: TokenBreakdown, right: TokenBreakdown): TokenBreakdown {
  return {
    totalTokens: left.totalTokens + right.totalTokens,
    inputTokens: left.inputTokens + right.inputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    reasoningOutputTokens:
      left.reasoningOutputTokens + right.reasoningOutputTokens,
  };
}

/** OpenCode catalog `limit.context` → BB context-window size. */
export function modelContextLimit(raw: unknown): number | null {
  if (!raw || typeof raw !== "object") return null;
  const limit = (raw as { limit?: unknown }).limit;
  if (!limit || typeof limit !== "object") return null;
  const context = (limit as { context?: unknown }).context;
  return typeof context === "number" && Number.isFinite(context) && context > 0
    ? context
    : null;
}

export function rememberModelWindows(
  windows: Map<string, number>,
  providers: ReadonlyArray<{ id: string; models?: unknown }>,
): void {
  for (const provider of providers) {
    if (!provider.models || typeof provider.models !== "object") continue;
    for (const [modelId, raw] of Object.entries(
      provider.models as Record<string, unknown>,
    )) {
      const size = modelContextLimit(raw);
      if (size) windows.set(`${provider.id}/${modelId}`, size);
    }
  }
}

export function assistantTokenUsage(info: unknown): {
  last: TokenBreakdown;
  used: number;
  modelId: string | null;
} | null {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  if (record.role !== undefined && record.role !== "assistant") return null;
  const tokens = record.tokens;
  if (!tokens || typeof tokens !== "object") return null;
  const body = tokens as Record<string, unknown>;
  const cache =
    body.cache && typeof body.cache === "object"
      ? (body.cache as Record<string, unknown>)
      : {};
  const input = num(body.input);
  const output = num(body.output);
  const reasoning = num(body.reasoning);
  const cacheRead = num(cache.read);
  const cacheWrite = num(cache.write);
  const cached = cacheRead + cacheWrite;
  const total = input + output + reasoning + cached;
  const used = input + cacheRead;
  if (total <= 0 && used <= 0) return null;
  const providerID =
    typeof record.providerID === "string" ? record.providerID : "";
  const modelID = typeof record.modelID === "string" ? record.modelID : "";
  return {
    last: {
      totalTokens: total,
      inputTokens: input,
      cachedInputTokens: cached,
      outputTokens: output,
      reasoningOutputTokens: reasoning,
    },
    used,
    modelId: providerID && modelID ? `${providerID}/${modelID}` : null,
  };
}

export function usageDeltasFromMessages(
  messages: ReadonlyArray<{ info?: unknown }>,
  contextWindows: ReadonlyMap<string, number>,
  attach: "open" | "currentOrLast" = "currentOrLast",
): ThreadDelta[] {
  let total = emptyUsage();
  let last = emptyUsage();
  let used: number | null = null;
  let modelId: string | null = null;
  for (const message of messages) {
    const parsed = assistantTokenUsage(message.info);
    if (!parsed) continue;
    last = parsed.last;
    used = parsed.used;
    modelId = parsed.modelId;
    total = addUsage(total, parsed.last);
  }
  if (used === null && last.totalTokens <= 0) return [];
  const size = modelId ? (contextWindows.get(modelId) ?? null) : null;
  const deltas: ThreadDelta[] = [];
  if (last.totalTokens > 0 || total.totalTokens > 0) {
    deltas.push({
      kind: "usage",
      total,
      last,
      modelContextWindow: size,
    });
  }
  if (used !== null || size !== null) {
    deltas.push({
      kind: "contextWindow",
      used,
      size,
      estimated: true,
      attach,
    });
  }
  return deltas;
}
