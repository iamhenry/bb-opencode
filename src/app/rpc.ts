export async function callPluginRpc<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`/api/v1/plugins/opencode/rpc/${method}`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function reportActionError(action: string, error: string): void {
  console.error(`[opencode] ${action}: ${error}`);
}
