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
