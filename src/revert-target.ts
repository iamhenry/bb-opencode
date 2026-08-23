export interface RevertTargetMessage {
  info: { id?: string; role?: string };
  parts: Array<{ type?: string; text?: string }>;
}

export function messageText(message: RevertTargetMessage): string {
  return textParts(message).join("").trim();
}

function normalizeVisibleText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function textParts(message: RevertTargetMessage): string[] {
  return message.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => (part.text ?? "").trim())
    .filter((text) => text.length > 0);
}

/** Texts a BB bubble can legally match, including the prompt after BB instructions. */
export function comparableMessageTexts(message: RevertTargetMessage): string[] {
  const parts = textParts(message);
  const joined = parts.join("").trim();
  const last = parts[parts.length - 1] ?? "";
  const stripped = joined.startsWith("[BB project instructions]") ? last : joined;
  return [
    ...new Set(
      [joined, last, stripped]
        .flatMap((text) => [text, normalizeVisibleText(text)])
        .filter((text) => text.length > 0),
    ),
  ];
}

/** Pick the OpenCode message `session.revert` should target. */
export function resolveRevertMessageId(args: {
  messages: readonly RevertTargetMessage[];
  role?: "user" | "assistant";
  text?: string;
  messageID?: string;
}): string | undefined {
  if (args.messageID) return args.messageID;
  const role = args.role;
  const needle = args.text?.trim() ?? "";
  const pool = args.messages.filter((message) => {
    if (!message.info.id) return false;
    if (role && message.info.role !== role) return false;
    return true;
  });
  if (!needle) {
    return pool.length === 1 ? pool[0]?.info.id : undefined;
  }
  const normalizedNeedle = normalizeVisibleText(needle);
  const exact = pool.filter((message) =>
    comparableMessageTexts(message).some(
      (text) => text === needle || text === normalizedNeedle,
    ),
  );
  if (exact.length === 1) return exact[0]?.info.id;
  if (exact.length > 1) return undefined;
  const prefix = needle.slice(0, 80);
  const fuzzy = pool.filter((message) =>
    comparableMessageTexts(message).some(
      (text) => text.includes(prefix) || needle.includes(text.slice(0, 80)),
    ),
  );
  if (fuzzy.length === 1) return fuzzy[0]?.info.id;
  return pool.length === 1 ? pool[0]?.info.id : undefined;
}
