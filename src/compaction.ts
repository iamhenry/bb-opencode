export function isOpenCodeCompactCommand(name: string): boolean {
  const normalized = name.toLowerCase();
  return normalized === "compact" || normalized === "summarize";
}

export function isCompactRequest(
  input: readonly {
    type: string;
    text?: string;
    mentions?: unknown[];
  }[],
): boolean {
  if (input.some((item) => item.type !== "text")) return false;
  for (const item of input) {
    const mentions = Array.isArray(item.mentions) ? item.mentions : [];
    for (const mention of mentions) {
      if (!mention || typeof mention !== "object") continue;
      const resource = (mention as { resource?: unknown }).resource;
      if (!resource || typeof resource !== "object") continue;
      const rec = resource as { kind?: unknown; name?: unknown; origin?: unknown };
      if (rec.kind === "command" && rec.name === "compact" && rec.origin === "builtin") {
        return true;
      }
    }
  }
  const text = input
    .map((item) => item.text ?? "")
    .join("")
    .trim();
  if (!text.startsWith("/")) return false;
  const name = text.slice(1).split(/\s/, 1)[0]?.toLowerCase() ?? "";
  if (!isOpenCodeCompactCommand(name)) return false;
  return text.slice(1 + name.length).trim() === "";
}

export function isCompactionSkipError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("nothing to compact") ||
    lower.includes("already compacted") ||
    lower.includes("session too small")
  );
}
