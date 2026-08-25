import { formatModelDisplayName } from "./model-label.js";

export interface CatalogProvider {
  id: string;
  models?: unknown;
  name?: string;
}

function isProvider(value: unknown): value is CatalogProvider {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      (value as { id: string }).id.length > 0,
  );
}

/** Only providers the user can actually call — never the full unauthenticated catalog. */
export function listAuthenticatedProviders(raw: unknown): CatalogProvider[] {
  if (Array.isArray(raw)) return raw.filter(isProvider);
  if (!raw || typeof raw !== "object") return [];
  const record = raw as {
    providers?: unknown;
    all?: unknown;
    connected?: unknown;
  };
  if (Array.isArray(record.providers)) {
    return record.providers.filter(isProvider);
  }
  const all = Array.isArray(record.all) ? record.all.filter(isProvider) : [];
  if (Array.isArray(record.connected)) {
    const allow = new Set(
      record.connected.filter((id): id is string => typeof id === "string"),
    );
    return all.filter((provider) => allow.has(provider.id));
  }
  return [];
}

/** OpenCode `GET /config` model → BB `provider/model` id. */
export function configDefaultModelId(raw: unknown): string | undefined {
  return modelRefFromUnknown(
    raw && typeof raw === "object" ? (raw as { model?: unknown }).model : undefined,
  );
}

/** Last prompted model on an OpenCode message list → BB `provider/model`. */
export function lastModelIdFromMessages(
  messages: readonly { info?: Record<string, unknown> }[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (!info) continue;
    const fromInfo =
      modelRefFromUnknown(info.model) ??
      modelRefFromUnknown(info);
    if (fromInfo) return fromInfo;
  }
  return undefined;
}

export function lastVariantFromMessages(
  messages: readonly { info?: Record<string, unknown> }[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const info = messages[i]?.info;
    if (!info) continue;
    const model = info.model;
    if (model && typeof model === "object") {
      const variant = (model as { variant?: unknown }).variant;
      if (typeof variant === "string" && variant) return variant;
    }
    if (typeof info.variant === "string" && info.variant) return info.variant;
  }
  return undefined;
}

function modelRefFromUnknown(raw: unknown): string | undefined {
  if (typeof raw === "string" && raw.includes("/")) return raw;
  if (!raw || typeof raw !== "object") return undefined;
  const providerID = (raw as { providerID?: unknown }).providerID;
  const modelID = (raw as { modelID?: unknown }).modelID;
  if (typeof providerID === "string" && typeof modelID === "string") {
    return `${providerID}/${modelID}`;
  }
  return undefined;
}

function modelIdsOf(provider: CatalogProvider): string[] {
  if (!provider.models || typeof provider.models !== "object") return [];
  return Object.keys(provider.models as Record<string, unknown>);
}

export interface PickerModelRow {
  id: string;
  model: string;
  displayName: string;
  description: string;
  routeProviderId: string;
  raw: unknown;
}

function modelNameOf(raw: unknown, fallback: string): string {
  if (raw && typeof raw === "object") {
    const name = (raw as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) return name;
  }
  return fallback;
}

/** One BB picker row per `provider/model` id. Pretty `provider.name` for search. */
export function listPickerModels(
  providers: readonly CatalogProvider[],
): PickerModelRow[] {
  const seen = new Set<string>();
  const rows: PickerModelRow[] = [];
  for (const provider of providers) {
    const prefix = provider.name?.trim() || provider.id;
    const models =
      provider.models && typeof provider.models === "object"
        ? (provider.models as Record<string, unknown>)
        : {};
    for (const modelId of Object.keys(models)) {
      const id = `${provider.id}/${modelId}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const raw = models[modelId];
      rows.push({
        id,
        // ACP shape: picker value is the full provider/model id, not the bare key.
        model: id,
        displayName: formatModelDisplayName(prefix, modelNameOf(raw, modelId)),
        description: provider.id,
        routeProviderId: provider.id,
        raw,
      });
    }
  }
  return rows;
}

/** BB `options.model` is often the catalog `model` field (bare id), not `provider/model`. */
export function coerceModelRef(
  raw: string | undefined,
  args: {
    providers?: readonly CatalogProvider[];
    lastPrompted?: string;
    configured?: string;
  } = {},
): string | undefined {
  const trimmed = raw?.trim() ?? "";
  if (trimmed.includes("/")) return trimmed;
  const hinted = [args.lastPrompted, args.configured].filter(
    (value): value is string => typeof value === "string" && value.includes("/"),
  );
  if (trimmed) {
    for (const hint of hinted) {
      const slash = hint.indexOf("/");
      if (hint.slice(slash + 1) === trimmed) return hint;
    }
    const matches: string[] = [];
    for (const provider of args.providers ?? []) {
      if (modelIdsOf(provider).includes(trimmed)) {
        matches.push(`${provider.id}/${trimmed}`);
      }
    }
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      for (const prefix of ["openai", "anthropic", "opencode"]) {
        const hit = matches.find((id) => id.startsWith(`${prefix}/`));
        if (hit) return hit;
      }
      return matches[0];
    }
  }
  return hinted[0];
}
