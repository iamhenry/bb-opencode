export const UNBOUND_NEXT_AGENT_KEY = "*";

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
  projectId?: string | null,
): string | undefined {
  if (projectId) {
    const hit = store.get(projectId);
    if (hit) return hit;
  }
  return store.get(UNBOUND_NEXT_AGENT_KEY);
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
  // New compose has no thread yet. Use the project's default so the Agent
  // chip can appear on the pre-thread screen when OpenCode is the default.
  void args.composeKind;
  return args.projectDefaultProviderId ?? null;
}
