export type ComposerChrome = {
  providerId: string | null;
  status: "selected" | "default" | "unknown" | "hidden";
  agent: string;
  options: Array<{ name: string; description: string | null }>;
  error: string | null;
};

export function displayedComposerAgent(
  options: ComposerChrome["options"],
  agent: string,
  status: ComposerChrome["status"] | undefined,
): ComposerChrome["options"][number] | undefined {
  return (
    options.find((option) => option.name === agent) ??
    (status === "selected" && agent
      ? { name: agent, description: null }
      : options[0])
  );
}

let lastArmed = "";

export function rememberComposerAgent(agent: string): void {
  const name = agent.trim();
  if (name) lastArmed = name;
}

export function lastArmedComposerAgent(): string {
  return lastArmed;
}

export function resetLastArmedComposerAgent(): void {
  lastArmed = "";
}

/** Keep the pick across new-thread → first thread. Reset only on thread hops. */
export function shouldResetArmedComposerAgent(
  previousThreadId: string | null,
  nextThreadId: string | null,
): boolean {
  return Boolean(
    previousThreadId && nextThreadId && previousThreadId !== nextThreadId,
  );
}

/** Chrome hydrate must not clobber a click, or a remount before lastUserAgent. */
export function shouldApplyHydratedAgent(args: {
  userPicked: boolean;
  chromeStatus?: ComposerChrome["status"];
  chromeAgent?: string;
  armedAgent?: string;
}): boolean {
  if (args.userPicked) return false;
  if (!args.chromeAgent) return false;
  if (
    args.chromeStatus === "default" &&
    args.armedAgent &&
    args.armedAgent !== args.chromeAgent
  ) {
    return false;
  }
  return true;
}

/** New-thread has no threadId; the visible chip must arm before send. */
export function composerAgentShouldArm(args: {
  visible: boolean;
  agent: string;
}): boolean {
  return args.visible && args.agent.trim().length > 0;
}

const inflight = new Map<string, Promise<ComposerChrome>>();

export function composerChromeKey(
  threadId: string | null,
  projectId: string | null,
): string {
  return `${threadId ?? ""}:${projectId ?? ""}`;
}

export function fetchComposerChrome(
  call: (input: {
    threadId: string | null;
    projectId: string | null;
  }) => Promise<ComposerChrome>,
  input: { threadId: string | null; projectId: string | null },
): Promise<ComposerChrome> {
  const key = composerChromeKey(input.threadId, input.projectId);
  const pending = inflight.get(key);
  if (pending) return pending;
  const next = call(input).finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, next);
  return next;
}

export function resetComposerChromeInflight(): void {
  inflight.clear();
}
