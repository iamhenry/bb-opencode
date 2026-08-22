export const NEXT_ADOPT_TTL_MS = 15_000;

export interface NextAdopt {
  projectId: string;
  hostId: string;
  opencodeSessionId: string;
  armedAt: number;
}

export function createNextAdoptStore(): Map<string, NextAdopt> {
  return new Map();
}

export function armNextAdopt(
  store: Map<string, NextAdopt>,
  adopt: Omit<NextAdopt, "armedAt">,
  now = Date.now(),
): void {
  store.set(adopt.projectId, { ...adopt, armedAt: now });
}

export function consumeNextAdopt(
  store: Map<string, NextAdopt>,
  args: { projectId: string; now?: number; isNewThread?: boolean },
): NextAdopt | undefined {
  if (args.isNewThread === false) return undefined;
  const adopt = store.get(args.projectId);
  if (!adopt) return undefined;
  const now = args.now ?? Date.now();
  if (now - adopt.armedAt > NEXT_ADOPT_TTL_MS) {
    store.delete(args.projectId);
    return undefined;
  }
  store.delete(args.projectId);
  return adopt;
}

export function peekNextAdopt(
  store: Map<string, NextAdopt>,
  projectId: string,
): NextAdopt | undefined {
  return store.get(projectId);
}
