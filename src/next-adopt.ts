export const NEXT_ADOPT_TTL_MS = 15_000;

export interface NextAdopt {
  projectId: string;
  hostId: string;
  opencodeSessionId: string;
  bindOnly?: boolean;
  armedAt: number;
}

export function createNextAdoptStore(): NextAdopt[] {
  return [];
}

export function armNextAdopt(
  store: NextAdopt[],
  adopt: Omit<NextAdopt, "armedAt">,
  now = Date.now(),
): void {
  store.push({ ...adopt, armedAt: now });
}

function dropExpired(store: NextAdopt[], now: number): void {
  for (let index = store.length - 1; index >= 0; index -= 1) {
    const row = store[index];
    if (!row || now - row.armedAt > NEXT_ADOPT_TTL_MS) {
      store.splice(index, 1);
    }
  }
}

export function consumeNextAdopt(
  store: NextAdopt[],
  args: { projectId: string; now?: number; isNewThread?: boolean },
): NextAdopt | undefined {
  if (args.isNewThread === false) return undefined;
  const now = args.now ?? Date.now();
  dropExpired(store, now);
  const index = store.findIndex((row) => row.projectId === args.projectId);
  if (index < 0) return undefined;
  const [adopt] = store.splice(index, 1);
  return adopt;
}

export function disarmNextAdopt(
  store: NextAdopt[],
  args: { projectId: string; opencodeSessionId: string },
): void {
  const index = store.findIndex(
    (row) =>
      row.projectId === args.projectId &&
      row.opencodeSessionId === args.opencodeSessionId,
  );
  if (index >= 0) store.splice(index, 1);
}

export function peekNextAdopt(
  store: NextAdopt[],
  projectId: string,
  now = Date.now(),
): NextAdopt | undefined {
  dropExpired(store, now);
  return store.find((row) => row.projectId === projectId);
}
