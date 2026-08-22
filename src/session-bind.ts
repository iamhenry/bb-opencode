export function sessionIdFromThreadEvents(events: unknown): string | null {
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
      data?: { providerThreadId?: unknown };
      providerThreadId?: unknown;
    };
    if (record.type !== "thread/identity") continue;
    const id = record.data?.providerThreadId ?? record.providerThreadId;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}
