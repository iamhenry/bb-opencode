export interface AgentStampStore {
  next: Map<string, string>;
  queued: Map<string, string[]>;
}

export function createAgentStampStore(): AgentStampStore {
  return { next: new Map(), queued: new Map() };
}

export function stampAgent(
  store: AgentStampStore,
  args: { threadId: string; agent: string; queued: boolean },
): void {
  if (args.queued) {
    const queue = store.queued.get(args.threadId) ?? [];
    queue.push(args.agent);
    store.queued.set(args.threadId, queue);
    return;
  }
  store.next.set(args.threadId, args.agent);
}

export function peekAgent(
  store: AgentStampStore,
  threadId: string,
): string | undefined {
  const queued = store.queued.get(threadId);
  if (queued && queued.length > 0) return queued[0];
  return store.next.get(threadId);
}

export function settleTurn(store: AgentStampStore, threadId: string): void {
  const queued = store.queued.get(threadId);
  if (!queued || queued.length === 0) return;
  queued.shift();
  if (queued.length === 0) store.queued.delete(threadId);
}

export function clearThread(store: AgentStampStore, threadId: string): void {
  store.next.delete(threadId);
  store.queued.delete(threadId);
}
