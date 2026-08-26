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
