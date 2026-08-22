import { PROVIDER_ID } from "../identity.js";

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

export async function runMessageUndo(args: {
  threadId: string;
  role: "user" | "assistant";
  text: string;
}): Promise<void> {
  const provider = await callPluginRpc<{ providerId: string | null }>(
    "threadProvider",
    { threadId: args.threadId },
  );
  if (provider.providerId !== PROVIDER_ID) return;
  await callPluginRpc("undo", {
    threadId: args.threadId,
    role: args.role,
    text: args.text,
  });
}

export async function runMessageRedo(args: { threadId: string }): Promise<void> {
  const provider = await callPluginRpc<{ providerId: string | null }>(
    "threadProvider",
    { threadId: args.threadId },
  );
  if (provider.providerId !== PROVIDER_ID) return;
  await callPluginRpc("redo", { threadId: args.threadId });
}
