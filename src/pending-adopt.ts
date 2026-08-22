export interface PendingAdoptKey {
  projectId: string;
  hostId: string;
  opencodeSessionId: string;
}

export function pendingAdoptStorageKey(key: PendingAdoptKey): string {
  return `pending-adopt:${key.projectId}:${key.hostId}:${key.opencodeSessionId}`;
}

export function openIntentStorageKey(args: {
  projectId: string;
  hostId: string;
}): string {
  return `open-intent:${args.projectId}:${args.hostId}`;
}

export interface PendingAdoptRecord {
  projectId: string;
  hostId: string;
  opencodeSessionId: string;
  createdAt: number;
}

export interface OpenIntentRecord {
  projectId: string;
  hostId: string;
  opencodeSessionId: string;
  createdAt: number;
}

export function consumeOpenIntent(args: {
  intent: OpenIntentRecord | undefined;
  projectId: string;
  hostId: string;
}): string | undefined {
  if (!args.intent) return undefined;
  if (args.intent.projectId !== args.projectId) return undefined;
  if (args.intent.hostId !== args.hostId) return undefined;
  return args.intent.opencodeSessionId;
}
