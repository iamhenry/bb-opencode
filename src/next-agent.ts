export const UNBOUND_NEXT_AGENT_KEY = "*";

/** An armed agent left unclaimed this long is dropped, so a failed spawn
 * can't turn a thread opened much later into that agent. The new-thread
 * composer re-arms well inside this window while it stays open. */
export const NEXT_AGENT_TTL_MS = 60_000;

type Armed = { agent: string; at: number };
export type NextAgentStore = Map<string, Armed>;

export function createNextAgentStore(): NextAgentStore {
  return new Map();
}

export function armNextAgent(
  store: NextAgentStore,
  projectId: string,
  agent: string,
  now = Date.now(),
): void {
  store.set(projectId, { agent, at: now });
}

function liveAgent(
  store: NextAgentStore,
  key: string,
  now: number,
): string | undefined {
  const armed = store.get(key);
  if (!armed) return undefined;
  if (now - armed.at > NEXT_AGENT_TTL_MS) {
    store.delete(key);
    return undefined;
  }
  return armed.agent;
}

export function consumeNextAgent(
  store: NextAgentStore,
  projectId: string,
  now = Date.now(),
): string | undefined {
  const agent = liveAgent(store, projectId, now);
  store.delete(projectId);
  return agent;
}

/** One new thread claims the armed agent; later threads don't inherit it. */
export function takeNextAgent(
  store: NextAgentStore,
  projectId?: string | null,
  now = Date.now(),
): string | undefined {
  return (
    (projectId ? consumeNextAgent(store, projectId, now) : undefined) ??
    consumeNextAgent(store, UNBOUND_NEXT_AGENT_KEY, now)
  );
}

export function peekNextAgent(
  store: NextAgentStore,
  projectId?: string | null,
  now = Date.now(),
): string | undefined {
  return (
    (projectId ? liveAgent(store, projectId, now) : undefined) ??
    liveAgent(store, UNBOUND_NEXT_AGENT_KEY, now)
  );
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
