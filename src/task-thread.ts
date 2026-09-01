import { shouldPublishOpenCodeTitle } from "./session-title.js";

export const TASK_CHILD_BIND_TEXT = "OpenCode Task child";

export function taskChildThreadTitle(title: string | null | undefined): string {
  if (title && shouldPublishOpenCodeTitle(title)) return title;
  return "Task";
}

export function shouldAutoBindTaskChild(args: {
  parentBound: boolean;
  alreadyImported: boolean;
  running: boolean;
}): boolean {
  return args.parentBound && args.running && !args.alreadyImported;
}

/** `threads.get` / spawn 404 must not fail the whole 750ms Task poll. */
export function isThreadNotFoundError(error: unknown): boolean {
  const text = String(error);
  return /404/.test(text) && /thread not found/i.test(text);
}

/** BB thread list often omits providerThreadId; resolve it from identity events. */
export function isOpenCodeParentThread(thread: {
  providerId?: string | null;
  id?: string | null;
  projectId?: string | null;
  parentThreadId?: string | null;
}): boolean {
  return (
    thread.providerId === "opencode" &&
    Boolean(thread.id) &&
    Boolean(thread.projectId) &&
    !thread.parentThreadId
  );
}

export function taskChildBindInput(): Array<{
  type: "text";
  text: string;
  mentions: [];
}> {
  return [
    {
      type: "text",
      text: TASK_CHILD_BIND_TEXT,
      mentions: [],
    },
  ];
}

export function splitModelRef(
  model: string | null | undefined,
): { providerID: string; modelID: string } | null {
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return null;
  return {
    providerID: model.slice(0, slash),
    modelID: model.slice(slash + 1),
  };
}
