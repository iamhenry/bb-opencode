export interface ParsedSlashCommand {
  name: string;
  arguments: string;
}

export interface ListedCommand {
  name: string;
  description?: string | null;
}

const LEADING_SLASH = /^\/(\S+)(?:\s+([\s\S]*))?$/;

export function firstTextPart(
  input: readonly { type: string; text?: string }[],
): string {
  for (const item of input) {
    if (item.type === "text") return item.text ?? "";
  }
  return "";
}

export function hasNonTextParts(
  input: readonly { type: string }[],
): boolean {
  return input.some((item) => item.type !== "text");
}

export function parseLeadingSlash(text: string): ParsedSlashCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return null;
  const match = LEADING_SLASH.exec(trimmed);
  if (!match?.[1] || match[1] === "/") return null;
  return {
    name: match[1],
    arguments: (match[2] ?? "").trimEnd(),
  };
}

export function matchListedCommand(
  name: string,
  commands: readonly ListedCommand[],
): ListedCommand | undefined {
  return commands.find((command) => command.name === name);
}

