export interface NextAdopt {
  projectId: string;
  hostId: string;
  opencodeSessionId: string;
}

export function createNextAdoptStore(): Map<string, NextAdopt> {
  return new Map();
}

export function armNextAdopt(
  store: Map<string, NextAdopt>,
  adopt: NextAdopt,
): void {
  store.set(adopt.projectId, adopt);
}

export function consumeNextAdopt(
  store: Map<string, NextAdopt>,
  projectId: string,
): NextAdopt | undefined {
  const adopt = store.get(projectId);
  if (!adopt) return undefined;
  store.delete(projectId);
  return adopt;
}

export function peekNextAdopt(
  store: Map<string, NextAdopt>,
  projectId: string,
): NextAdopt | undefined {
  return store.get(projectId);
}
