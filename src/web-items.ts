export function isWebSearchToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "websearch" ||
    normalized === "web_search" ||
    normalized === "webresearch" ||
    normalized === "web_research"
  );
}

export function isWebFetchToolName(name: string): boolean {
  const normalized = name.toLowerCase();
  return (
    normalized === "webfetch" ||
    normalized === "web_fetch" ||
    normalized === "fetch"
  );
}

export function webSearchItem(input: Record<string, unknown> | undefined): {
  type: "webSearch";
  queries: string[];
} {
  const query =
    stringField(input, "query") ??
    stringField(input, "q") ??
    stringField(input, "search") ??
    "";
  return { type: "webSearch", queries: query ? [query] : ["search"] };
}

export function webFetchItem(input: Record<string, unknown> | undefined): {
  type: "webFetch";
  url: string;
  prompt: string | null;
  pattern: string | null;
} {
  return {
    type: "webFetch",
    url: stringField(input, "url") ?? stringField(input, "href") ?? "",
    prompt: stringField(input, "prompt") ?? null,
    pattern: stringField(input, "pattern") ?? null,
  };
}

export function webSearchPresentation(query: string): {
  label: { pending: string; completed: string };
  icon: { glyph: string };
  title?: string;
} {
  return {
    label: { pending: "Searching the web", completed: "Searched the web" },
    icon: { glyph: "Globe" },
    ...(query ? { title: query } : {}),
  };
}

export function webFetchPresentation(url: string): {
  label: { pending: string; completed: string };
  icon: { glyph: string };
  title?: string;
} {
  return {
    label: { pending: "Fetching page", completed: "Fetched page" },
    icon: { glyph: "Browser" },
    ...(url ? { title: url } : {}),
  };
}

function stringField(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
