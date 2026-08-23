import { PROVIDER_ID } from "../identity.js";
import { callPluginRpc, reportActionError } from "./rpc.js";

export async function runMessageUndo(args: {
  threadId: string;
  role: "user" | "assistant";
  text: string;
}): Promise<void> {
  try {
    const provider = await callPluginRpc<{ providerId: string | null }>(
      "threadProvider",
      { threadId: args.threadId },
    );
    if (provider.providerId !== PROVIDER_ID) return;
    const result = await callPluginRpc<{ ok: boolean; error: string | null }>(
      "undo",
      {
        threadId: args.threadId,
        role: args.role,
        text: args.text,
      },
    );
    if (!result.ok) {
      reportActionError(
        "Revert from here",
        result.error ?? "could not match that message",
      );
      return;
    }
    reloadThread();
  } catch (error) {
    reportActionError(
      "Revert from here",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export async function runMessageRedo(args: { threadId: string }): Promise<void> {
  try {
    const provider = await callPluginRpc<{ providerId: string | null }>(
      "threadProvider",
      { threadId: args.threadId },
    );
    if (provider.providerId !== PROVIDER_ID) return;
    const result = await callPluginRpc<{ ok: boolean; error: string | null }>(
      "redo",
      { threadId: args.threadId },
    );
    if (!result.ok) {
      reportActionError("Redo revert", result.error ?? "nothing to redo");
      return;
    }
    reloadThread();
  } catch (error) {
    reportActionError(
      "Redo revert",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function reloadThread(): void {
  if (typeof window === "undefined") return;
  window.location.reload();
}
