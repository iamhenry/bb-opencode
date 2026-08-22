export interface RevertTargetMessage {
  info: { id?: string; role?: string };
  parts: Array<{ type?: string; text?: string }>;
}

export function messageText(message: RevertTargetMessage): string {
  return message.parts
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text ?? "")
    .join("")
    .trim();
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
  if (!needle) return undefined;
  const exact = pool.filter((message) => messageText(message) === needle);
  if (exact.length === 1) return exact[0]?.info.id;
  if (exact.length > 1) return undefined;
  const prefix = needle.slice(0, 80);
  const fuzzy = pool.filter((message) =>
    messageText(message).includes(prefix),
  );
  if (fuzzy.length === 1) return fuzzy[0]?.info.id;
  return undefined;
}
