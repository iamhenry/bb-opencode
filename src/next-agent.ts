export function createNextAgentStore(): Map<string, string> {
  return new Map();
}

export function armNextAgent(
  store: Map<string, string>,
  projectId: string,
  agent: string,
): void {
  store.set(projectId, agent);
}

export function consumeNextAgent(
  store: Map<string, string>,
  projectId: string,
): string | undefined {
  const agent = store.get(projectId);
  if (agent === undefined) return undefined;
  store.delete(projectId);
  return agent;
}

export function peekNextAgent(
  store: Map<string, string>,
  projectId: string,
): string | undefined {
  return store.get(projectId);
}

export function resolvePromptAgent(args: {
  stamped?: string;
  next?: string;
  configured?: string;
}): string {
  const stamped = args.stamped?.trim();
  if (stamped) return stamped;
  const next = args.next?.trim();
  if (next) return next;
  const configured = args.configured?.trim();
  if (configured) return configured;
  return "build";
}

export function resolveComposerProvider(args: {
  threadProviderId?: string | null;
  projectDefaultProviderId?: string | null;
  composeKind?: "new-thread" | "thread";
}): string | null {
  if (args.threadProviderId) return args.threadProviderId;
  // New compose has no thread provider. This plugin owns the OpenCode agent
  // chip there; stamp is ignored if the user sends with another provider.
  if (args.composeKind === "new-thread") return "opencode";
  return args.projectDefaultProviderId ?? null;
}
