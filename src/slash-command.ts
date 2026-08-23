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

export function insertCommandToken(draft: string, name: string): string {
  const match = draft.match(/^(\s*)\/\S*/);
  if (match) return `${match[1]}/${name} `;
  if (!draft.trim()) return `/${name} `;
  return `${draft.replace(/\s*$/, "")} /${name} `;
}

/** Leading `/token` with no trailing args. Null when this is not a slash query. */
export function slashAutocompleteQuery(text: string): string | null {
  const trimmedStart = text.replace(/^\s+/, "");
  if (!trimmedStart.startsWith("/") || trimmedStart.startsWith("//")) {
    return null;
  }
  if (/\s/.test(trimmedStart.slice(1))) return null;
  return trimmedStart.slice(1);
}

export function filterListedCommands(
  query: string,
  commands: readonly ListedCommand[],
): ListedCommand[] {
  const needle = query.toLowerCase();
  return commands.filter((command) => {
    const name = command.name.toLowerCase();
    if (name === "compact" || name === "summarize") return false;
    return name.startsWith(needle);
  });
}
