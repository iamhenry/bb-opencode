/** Matches OpenCode `Session.isDefaultTitle` (packages/opencode/src/session). */
const DEFAULT_TITLE =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultOpenCodeTitle(title: string): boolean {
  return DEFAULT_TITLE.test(title);
}

/** OpenCode's first-turn title agent replaces this placeholder. Do not stamp it on BB. */
export function shouldPublishOpenCodeTitle(title: string): boolean {
  return title.length > 0 && !isDefaultOpenCodeTitle(title);
}

const GREETING =
  /^(hi|hey+|hello|sup+|yo|good\s+(morning|afternoon|evening)|what'?s\s+(up|good|going)|how are you|you good|how'?s it going)\b/i;

export function firstVisibleUserText(
  messages: ReadonlyArray<{
    info?: Record<string, unknown>;
    parts?: Array<Record<string, unknown>>;
  }>,
): string {
  for (const message of messages) {
    if (message.info?.role !== "user") continue;
    const texts = (message.parts ?? [])
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => String(part.text).trim())
      .filter(
        (text) =>
          text.length > 0 &&
          !text.startsWith("[BB project instructions]") &&
          !text.startsWith("## BB skills"),
      );
    if (texts.length > 0) return texts[texts.length - 1]!;
  }
  return "";
}

/** When OpenCode `ensureTitle` fails, still publish a short name instead of the ISO placeholder. */
export function fallbackSessionTitle(userText: string): string | null {
  const text = userText.trim().replace(/\s+/g, " ");
  if (!text) return null;
  if (GREETING.test(text)) return "Casual greeting";
  const words = text
    .replace(/[.?!]+$/g, "")
    .split(" ")
    .filter(Boolean)
    .slice(0, 6);
  const title = words.join(" ");
  if (title.length < 2 || isDefaultOpenCodeTitle(title)) return null;
  return title.length > 80 ? `${title.slice(0, 77)}...` : title;
}

export function publishedTitleFromThreadEvents(events: unknown): string | null {
  const rows = Array.isArray(events)
    ? events
    : events && typeof events === "object" && "events" in events
      ? (events as { events: unknown }).events
      : [];
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const record = row as {
      type?: unknown;
      data?: { threadName?: unknown };
      threadName?: unknown;
    };
    if (record.type !== "thread/name/updated") continue;
    const name = record.data?.threadName ?? record.threadName;
    if (typeof name !== "string" || !shouldPublishOpenCodeTitle(name)) continue;
    return name;
  }
  return null;
}

export async function persistPublishedOpenCodeTitle(args: {
  providerId: string | null | undefined;
  title: string | null | undefined;
  listEvents: () => Promise<unknown>;
  updateTitle: (title: string) => Promise<void>;
}): Promise<boolean> {
  if (args.providerId !== "opencode") return false;
  if (args.title && args.title.trim().length > 0) return false;
  const name = publishedTitleFromThreadEvents(await args.listEvents());
  if (!name) return false;
  await args.updateTitle(name);
  return true;
}
