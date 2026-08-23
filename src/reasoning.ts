/** BB reasoning picker levels we can legally advertise. */
const BB_REASONING_ORDER = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "ultracode",
  "max",
  "ultra",
] as const;

type BbReasoningLevel = (typeof BB_REASONING_ORDER)[number];

const BB_REASONING = new Set<string>(BB_REASONING_ORDER);

const DESCRIPTIONS: Record<BbReasoningLevel, string> = {
  none: "No extended thinking",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  ultracode: "Extra high plus multi-agent workflow",
  max: "Maximum",
  ultra: "Maximum with task delegation",
};

export interface ModelReasoningEffort {
  reasoningEffort: BbReasoningLevel;
  description: string;
}

/** OpenCode catalog `variants` — object map or v2 `{id}[]`. */
export function variantKeysFromModel(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return [];
  const variants = (raw as { variants?: unknown }).variants;
  if (Array.isArray(variants)) {
    return variants.flatMap((entry) => {
      if (typeof entry === "string" && entry.length > 0) return [entry];
      if (
        entry &&
        typeof entry === "object" &&
        typeof (entry as { id?: unknown }).id === "string"
      ) {
        return [(entry as { id: string }).id];
      }
      return [];
    });
  }
  if (variants && typeof variants === "object") {
    return Object.keys(variants);
  }
  return [];
}

/** BB picker rows for one OpenCode model. Unknown keys like `minimal` are skipped. */
export function supportedReasoningEffortsForModel(
  raw: unknown,
): ModelReasoningEffort[] {
  const efforts = variantKeysFromModel(raw)
    .filter((key): key is BbReasoningLevel => BB_REASONING.has(key))
    .map((key) => ({
      reasoningEffort: key,
      description: DESCRIPTIONS[key],
    }));
  efforts.sort(
    (a, b) =>
      BB_REASONING_ORDER.indexOf(a.reasoningEffort) -
      BB_REASONING_ORDER.indexOf(b.reasoningEffort),
  );
  if (efforts.length > 0) return efforts;
  return [{ reasoningEffort: "none", description: DESCRIPTIONS.none }];
}

export function defaultReasoningEffortFor(
  efforts: readonly ModelReasoningEffort[],
): BbReasoningLevel {
  const ids = new Set(efforts.map((effort) => effort.reasoningEffort));
  for (const prefer of ["medium", "high", "low", "xhigh", "max"] as const) {
    if (ids.has(prefer)) return prefer;
  }
  return efforts[0]?.reasoningEffort ?? "none";
}

/** BB `reasoningLevel` → OpenCode message `variant`. */
export function openCodeVariantFor(
  reasoningLevel: string | undefined,
  available?: readonly string[],
): string | undefined {
  if (!reasoningLevel || reasoningLevel === "none") return undefined;
  const candidates = variantAliases(reasoningLevel);
  if (available && available.length > 0) {
    const allow = new Set(available);
    return candidates.find((candidate) => allow.has(candidate));
  }
  return candidates[0];
}

function variantAliases(level: string): string[] {
  switch (level) {
    case "low":
    case "medium":
    case "high":
    case "xhigh":
    case "max":
      return [level];
    case "ultra":
      return ["ultra", "max", "xhigh"];
    case "ultracode":
      return ["ultracode", "max", "xhigh"];
    default:
      return [];
  }
}

export function reasoningLevelOf(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const level = (options as { reasoningLevel?: unknown }).reasoningLevel;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}
