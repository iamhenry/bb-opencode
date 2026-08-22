export type PermissionAttach =
  | { action: "attach"; threadId: string }
  | { action: "drop"; reason: string };

export function resolvePermissionAttach(args: {
  askSessionId: string;
  boundThreadId?: string | null;
  parentSessionId?: string | null;
  parentThreadId?: string | null;
  parentInFlight?: boolean;
}): PermissionAttach {
  if (args.boundThreadId) {
    return { action: "attach", threadId: args.boundThreadId };
  }
  if (!args.parentSessionId || !args.parentThreadId) {
    return { action: "drop", reason: "no resolvable session" };
  }
  if (!args.parentInFlight) {
    return { action: "drop", reason: "parent turn is not in flight" };
  }
  return { action: "attach", threadId: args.parentThreadId };
}
