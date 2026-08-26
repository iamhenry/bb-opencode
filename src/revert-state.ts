export const OPENCODE_REVERT_CHANNEL = "opencode-revert-state";

export interface RevertStateMessage {
  info: { id?: string; role?: string };
  parts: Array<{
    type?: string;
    text?: string;
    synthetic?: boolean;
    filename?: string;
    name?: string;
    url?: string;
  }>;
}

export interface RevertedMessagePreview {
  id: string;
  text: string;
  attachments: string[];
}

export interface OpenCodeRevertState {
  active: boolean;
  messageID: string | null;
  promptText: string | null;
  messages: RevertedMessagePreview[];
}

export const EMPTY_REVERT_STATE: OpenCodeRevertState = {
  active: false,
  messageID: null,
  promptText: null,
  messages: [],
};

function nonSyntheticText(message: RevertStateMessage): string {
  return message.parts
    .filter(
      (part) =>
        part.type === "text" &&
        part.synthetic !== true &&
        typeof part.text === "string",
    )
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
}

function attachmentLabel(part: RevertStateMessage["parts"][number]): string | null {
  if (part.type !== "file" || part.synthetic === true) return null;
  const label = part.filename ?? part.name;
  if (typeof label === "string" && label.trim()) return label.trim();
  if (typeof part.url === "string" && part.url.trim()) {
    const tail = part.url.split("/").pop();
    return tail && tail.trim() ? tail.trim() : "attachment";
  }
  return "attachment";
}

/**
 * OpenCode keeps the reverted suffix in storage until the next prompt. Project
 * that authoritative marker into the composer text and dock previews without
 * deleting or copying the provider rows.
 */
export function buildOpenCodeRevertState(args: {
  revertMessageID?: string;
  messages: readonly RevertStateMessage[];
}): OpenCodeRevertState {
  const messageID = args.revertMessageID;
  if (!messageID) return EMPTY_REVERT_STATE;
  const index = args.messages.findIndex((message) => message.info.id === messageID);
  if (index < 0) return EMPTY_REVERT_STATE;

  const messages = args.messages.slice(index).flatMap((message) => {
    const id = message.info.id;
    if (message.info.role !== "user" || !id) return [];
    return [
      {
        id,
        text: nonSyntheticText(message),
        attachments: message.parts.flatMap((part) => {
          const label = attachmentLabel(part);
          return label ? [label] : [];
        }),
      },
    ];
  });

  return {
    active: true,
    messageID,
    promptText: messages[0]?.text ?? "",
    messages,
  };
}
