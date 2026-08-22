export type PermissionTag = "ok" | "resolved" | "unknown";

export type OpenCodePermissionReply = "once" | "always" | "reject";

export interface OpenCodePermissionAsk {
  id?: unknown;
  sessionID?: unknown;
  permission?: unknown;
  patterns?: unknown;
  metadata?: unknown;
  always?: unknown;
  tool?: unknown;
}

export type BbApprovalSubject =
  | {
      kind: "command";
      itemId: string;
      command: string;
      cwd: string | null;
      actions: Array<{ type: "unknown"; command: string }>;
      sessionGrant: null;
    }
  | {
      kind: "file_change";
      itemId: string;
      writeScope: string | null;
      sessionGrant: null;
    }
  | {
      kind: "tool_use";
      itemId: string;
      tool: string;
      presentation: {
        label: { pending: string; completed: string };
        icon: { glyph: string };
        detail?: string;
      };
    };

export interface MappedPermission {
  tag: PermissionTag;
  requestId?: string;
  sessionId?: string;
  permission?: string;
  subject?: BbApprovalSubject;
  reason?: string;
}

const COMMAND_PERMISSIONS = new Set(["bash", "shell"]);
const FILE_CHANGE_PERMISSIONS = new Set([
  "edit",
  "write",
  "patch",
  "multiedit",
  "apply_patch",
]);

export function mapPermissionAsk(raw: unknown): MappedPermission {
  if (!raw || typeof raw !== "object") {
    return { tag: "unknown", reason: "ask is not an object" };
  }
  const ask = raw as OpenCodePermissionAsk;
  if (typeof ask.id !== "string" || ask.id.length === 0) {
    return { tag: "unknown", reason: "missing permission id" };
  }
  if (typeof ask.sessionID !== "string" || ask.sessionID.length === 0) {
    return { tag: "unknown", reason: "missing sessionID" };
  }
  if (typeof ask.permission !== "string" || ask.permission.length === 0) {
    return { tag: "unknown", reason: "missing permission name" };
  }

  const metadata =
    ask.metadata && typeof ask.metadata === "object"
      ? (ask.metadata as Record<string, unknown>)
      : {};
  const patterns = Array.isArray(ask.patterns)
    ? ask.patterns.filter((item): item is string => typeof item === "string")
    : [];
  const itemId =
    ask.tool &&
    typeof ask.tool === "object" &&
    typeof (ask.tool as { callID?: unknown }).callID === "string"
      ? ((ask.tool as { callID: string }).callID as string)
      : ask.id;

  const permission = ask.permission;
  if (COMMAND_PERMISSIONS.has(permission)) {
    const command =
      (typeof metadata.command === "string" && metadata.command) ||
      patterns[0];
    if (!command) {
      return {
        tag: "unknown",
        requestId: ask.id,
        sessionId: ask.sessionID,
        permission,
        reason: "bash ask missing command",
      };
    }
    return {
      tag: "ok",
      requestId: ask.id,
      sessionId: ask.sessionID,
      permission,
      subject: {
        kind: "command",
        itemId,
        command,
        cwd: typeof metadata.cwd === "string" ? metadata.cwd : null,
        actions: [{ type: "unknown", command }],
        sessionGrant: null,
      },
    };
  }

  if (FILE_CHANGE_PERMISSIONS.has(permission)) {
    const writeScope =
      (typeof metadata.filepath === "string" && metadata.filepath) ||
      (typeof metadata.path === "string" && metadata.path) ||
      patterns[0] ||
      null;
    return {
      tag: "ok",
      requestId: ask.id,
      sessionId: ask.sessionID,
      permission,
      subject: {
        kind: "file_change",
        itemId,
        writeScope,
        sessionGrant: null,
      },
    };
  }

  return {
    tag: "ok",
    requestId: ask.id,
    sessionId: ask.sessionID,
    permission,
    subject: {
      kind: "tool_use",
      itemId,
      tool: permission,
      presentation: {
        label: {
          pending: `Allow ${permission}`,
          completed: `Allowed ${permission}`,
        },
        icon: { glyph: "Shield" },
        detail: patterns[0],
      },
    },
  };
}

export function shouldAutoApprove(args: {
  tag: PermissionTag;
  permissionMode: string | undefined;
}): boolean {
  if (args.tag !== "ok") return false;
  return args.permissionMode === "full";
}

export function shouldShowCard(args: {
  tag: PermissionTag;
  permissionMode: string | undefined;
}): boolean {
  if (args.tag !== "ok") return false;
  return args.permissionMode !== "full";
}

export function decisionToReply(
  decision: string,
): OpenCodePermissionReply | undefined {
  if (decision === "allow_once") return "once";
  if (decision === "allow_for_session") return "always";
  if (decision === "deny") return "reject";
  return undefined;
}

export function isBashToolName(name: string): boolean {
  return COMMAND_PERMISSIONS.has(name);
}
