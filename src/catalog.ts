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
