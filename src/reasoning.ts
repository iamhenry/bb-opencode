/** BB `reasoningLevel` → OpenCode message `variant`. */
export function openCodeVariantFor(
  reasoningLevel: string | undefined,
): string | undefined {
  if (!reasoningLevel) return undefined;
  switch (reasoningLevel) {
    case "low":
    case "medium":
    case "high":
      return reasoningLevel;
    case "xhigh":
    case "max":
    case "ultra":
    case "ultracode":
      return "max";
    case "none":
      return undefined;
    default:
      return undefined;
  }
}

export function reasoningLevelOf(options: unknown): string | undefined {
  if (!options || typeof options !== "object") return undefined;
  const level = (options as { reasoningLevel?: unknown }).reasoningLevel;
  return typeof level === "string" && level.length > 0 ? level : undefined;
}
