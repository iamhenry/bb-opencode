import { formatModelDisplayName } from "./model-label.js";

export type RunChipRole = "user" | "assistant";

export interface RunChipMessage {
  role: RunChipRole;
  agent: string;
  providerId: string;
  modelId: string;
  reasoning?: string;
}

export interface RunChipTarget {
  id: string;
  role: RunChipRole;
  turnId?: string | null;
}

export interface RunChipRow {
  id: string;
  label: string;
  title: string;
}

export function messageMetaFromInfo(info: unknown): RunChipMessage | null {
  if (!info || typeof info !== "object") return null;
  const record = info as Record<string, unknown>;
  const role =
    record.role === "user" || record.role === "assistant" ? record.role : null;
  if (!role) return null;

  const agent =
    typeof record.agent === "string" && record.agent
      ? record.agent
      : typeof record.mode === "string" && record.mode
        ? record.mode
        : "";

  let providerId = "";
  let modelId = "";
  if (record.model && typeof record.model === "object") {
    const model = record.model as Record<string, unknown>;
    if (typeof model.providerID === "string") providerId = model.providerID;
    if (typeof model.modelID === "string") modelId = model.modelID;
  }
  if (typeof record.providerID === "string" && record.providerID) {
    providerId = record.providerID;
  }
  if (typeof record.modelID === "string" && record.modelID) {
    modelId = record.modelID;
  }

  const reasoning =
    typeof record.variant === "string" && record.variant
      ? record.variant
      : typeof record.reasoning === "string" && record.reasoning
        ? record.reasoning
        : undefined;

  return {
    role,
    agent,
    providerId,
    modelId,
    ...(reasoning ? { reasoning } : {}),
  };
}

export function formatRunChip(args: {
  agent?: string;
  providerId?: string;
  modelId?: string;
  reasoning?: string | null;
}): { label: string; title: string } | null {
  const agent = args.agent?.trim() ?? "";
  const providerId = args.providerId?.trim() ?? "";
  const modelId = args.modelId?.trim() ?? "";
  const model =
    providerId || modelId ? formatModelDisplayName(providerId, modelId) : "";
  const reasoning = normalizeReasoning(args.reasoning);
  const parts = [model, reasoning, agent].filter(Boolean);
  if (parts.length === 0) return null;
  const label = parts.join(" · ");
  return { label, title: label };
}

export function collectChipTargets(rows: unknown): RunChipTarget[] {
  const targets: RunChipTarget[] = [];
  walkRows(rows, (row) => {
    if (row.kind !== "conversation") return;
    if (row.role !== "user" && row.role !== "assistant") return;
    if (row.role === "user" && row.initiator && row.initiator !== "user") return;
    if (!row.id) return;
    targets.push({
      id: row.id,
      role: row.role,
      turnId: row.turnId,
    });
  });
  return targets;
}

export function reasoningByTurnFromEvents(events: unknown): Map<string, string> {
  const byTurn = new Map<string, string>();
  const rows = eventRows(events);
  for (const row of rows) {
    const type = stringField(row, "type") ?? stringField(row, "eventType");
    if (type !== "client/turn/requested") continue;
    const turnId =
      stringField(row, "turnId") ??
      stringField(asRecord(row.payload), "turnId") ??
      stringField(asRecord(row.data), "turnId");
    const execution =
      asRecord(row.execution) ??
      asRecord(asRecord(row.payload)?.execution) ??
      asRecord(asRecord(row.data)?.execution);
    const reasoning =
      stringField(execution, "reasoningLevel") ??
      stringField(asRecord(row.payload), "reasoningLevel");
    if (turnId && reasoning) byTurn.set(turnId, reasoning);
  }
  return byTurn;
}

/** Timeline pages arrive newest-first. Flatten so assign walks oldest → newest. */
export function flattenChipTargetPages(
  pages: readonly (readonly RunChipTarget[])[],
): RunChipTarget[] {
  const ordered: RunChipTarget[] = [];
  for (let i = pages.length - 1; i >= 0; i -= 1) {
    ordered.push(...(pages[i] ?? []));
  }
  return ordered;
}

export function assignRunChips(args: {
  targets: readonly RunChipTarget[];
  messages: readonly RunChipMessage[];
  reasoningByTurn?: ReadonlyMap<string, string>;
}): RunChipRow[] {
  const rows: RunChipRow[] = [];
  let current: RunChipMessage | null = null;
  let index = 0;

  for (const target of args.targets) {
    while (
      index < args.messages.length &&
      args.messages[index]?.role !== target.role
    ) {
      current = mergeMessage(current, args.messages[index]);
      index += 1;
    }
    if (index < args.messages.length && args.messages[index]?.role === target.role) {
      current = mergeMessage(current, args.messages[index]);
      index += 1;
    }
    if (!current) continue;

    const reasoning =
      (target.turnId ? args.reasoningByTurn?.get(target.turnId) : undefined) ??
      current.reasoning;
    const formatted = formatRunChip({
      agent: current.agent,
      providerId: current.providerId,
      modelId: current.modelId,
      reasoning,
    });
    if (!formatted) continue;
    rows.push({ id: target.id, ...formatted });
  }

  return rows;
}

function mergeMessage(
  current: RunChipMessage | null,
  next: RunChipMessage | undefined,
): RunChipMessage | null {
  if (!next) return current;
  if (!current) return next;
  return {
    role: next.role,
    agent: next.agent || current.agent,
    providerId: next.providerId || current.providerId,
    modelId: next.modelId || current.modelId,
    reasoning: next.reasoning || current.reasoning,
  };
}

function normalizeReasoning(value: string | null | undefined): string {
  const reasoning = value?.trim() ?? "";
  if (!reasoning || reasoning === "none") return "";
  return reasoning;
}

function walkRows(
  rows: unknown,
  visit: (row: {
    id?: string;
    kind?: string;
    role?: string;
    initiator?: string;
    turnId?: string | null;
  }) => void,
): void {
  if (!Array.isArray(rows)) return;
  for (const entry of rows) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as {
      id?: string;
      kind?: string;
      role?: string;
      initiator?: string;
      turnId?: string | null;
      children?: unknown;
      childRows?: unknown;
    };
    visit(row);
    walkRows(row.children, visit);
    walkRows(row.childRows, visit);
  }
}

function eventRows(events: unknown): Record<string, unknown>[] {
  if (Array.isArray(events)) {
    return events.filter(
      (row): row is Record<string, unknown> => Boolean(row) && typeof row === "object",
    );
  }
  if (events && typeof events === "object") {
    const record = events as { events?: unknown; rows?: unknown };
    if (Array.isArray(record.events)) return eventRows(record.events);
    if (Array.isArray(record.rows)) return eventRows(record.rows);
  }
  return [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value ? value : undefined;
}
