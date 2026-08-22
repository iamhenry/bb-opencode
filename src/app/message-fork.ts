import { PROVIDER_ID } from "../identity.js";
import { callPluginRpc, reportActionError } from "./rpc.js";

export function threadHref(projectId: string, threadId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;
}

export async function runMessageFork(args: {
  threadId: string;
  sourceSeqEnd: number;
}): Promise<void> {
  if (!Number.isInteger(args.sourceSeqEnd) || args.sourceSeqEnd < 0) {
    reportActionError("Fork into new thread", "message has no fork point");
    return;
  }
  const provider = await callPluginRpc<{ providerId: string | null }>(
    "threadProvider",
    { threadId: args.threadId },
  );
  if (provider.providerId !== PROVIDER_ID) return;
  const result = await callPluginRpc<{
    threadId: string | null;
    projectId: string | null;
    error: string | null;
  }>("forkFromMessage", {
    threadId: args.threadId,
    sourceSeqEnd: args.sourceSeqEnd,
  });
  if (!result.threadId || !result.projectId) {
    reportActionError(
      "Fork into new thread",
      result.error ?? "fork failed",
    );
    return;
  }
  window.location.assign(threadHref(result.projectId, result.threadId));
}
