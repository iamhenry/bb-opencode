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
  return unwrapPluginRpcResult<T>(await response.json(), method);
}

/** BB wraps plugin RPC as `{ ok: true, result }` or `{ ok: false, error }`. */
export function unwrapPluginRpcResult<T>(raw: unknown, method: string): T {
  if (!raw || typeof raw !== "object") {
    throw new Error(`${method} returned an empty response`);
  }
  const record = raw as { ok?: unknown; result?: unknown; error?: unknown };
  if (record.ok === false) {
    const error =
      typeof record.error === "string" && record.error
        ? record.error
        : `${method} failed`;
    throw new Error(error);
  }
  if (record.ok === true && "result" in record) {
    return record.result as T;
  }
  return raw as T;
}

export function reportActionError(action: string, error: string): void {
  console.error(`[opencode] ${action}: ${error}`);
  showActionToast(`${action}: ${error}`);
}

function showActionToast(message: string): void {
  if (typeof document === "undefined") return;
  let host = document.getElementById("oc-toast");
  if (!host) {
    host = document.createElement("div");
    host.id = "oc-toast";
    host.className = "oc-toast";
    host.setAttribute("role", "status");
    document.body.appendChild(host);
  }
  host.textContent = message;
  host.dataset.show = "true";
  window.clearTimeout(Number(host.dataset.timer ?? "0"));
  const timer = window.setTimeout(() => {
    host.dataset.show = "false";
  }, 4200);
  host.dataset.timer = String(timer);
}
