import { PROVIDER_ID } from "../identity.js";
import { callPluginRpc } from "./message-revert.js";

export function threadHref(projectId: string, threadId: string): string {
  return `/projects/${encodeURIComponent(projectId)}/threads/${encodeURIComponent(threadId)}`;
}

export async function runMessageFork(args: {
  threadId: string;
  sourceSeqEnd: number;
}): Promise<void> {
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
  if (!result.threadId || !result.projectId) return;
  window.location.assign(threadHref(result.projectId, result.threadId));
}
