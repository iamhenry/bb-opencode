export type FileChangeKind = "add" | "update" | "delete";

export interface FileChange {
  path: string;
  kind: FileChangeKind;
  oldText?: string;
  newText?: string;
  diff?: string;
}

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "apply_patch",
  "applypatch",
  "multiedit",
  "multi_edit",
  "patch",
  "strreplace",
  "str_replace",
]);

export function isFileChangeToolName(name: string): boolean {
  return EDIT_TOOLS.has(name.toLowerCase());
}

export function fileChangePresentation(toolName: string): {
  label: { pending: string; completed: string };
  icon: { glyph: string };
} {
  const write = toolName.toLowerCase() === "write";
  return {
    label: write
      ? { pending: "Writing file", completed: "Wrote file" }
      : { pending: "Editing file", completed: "Edited file" },
    icon: { glyph: "EditFile" },
  };
}

export function fileChangesFromToolInput(
  toolName: string,
  input: Record<string, unknown> | undefined,
): FileChange[] {
  if (!input) return [];
  const path =
    stringField(input, "filePath") ??
    stringField(input, "path") ??
    stringField(input, "file");
  const oldText =
    stringField(input, "oldString") ??
    stringField(input, "oldText") ??
    stringField(input, "before");
  const newText =
    stringField(input, "newString") ??
    stringField(input, "newText") ??
    stringField(input, "content") ??
    stringField(input, "after");
  const diff = stringField(input, "patch") ?? stringField(input, "diff");
  if (path) {
    const kind: FileChangeKind =
      toolName.toLowerCase() === "write" && oldText === undefined
        ? "add"
        : "update";
    return [
      {
        path,
        kind,
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
        ...(diff !== undefined ? { diff } : {}),
      },
    ];
  }
  const edits = input.edits;
  if (Array.isArray(edits)) {
    return edits.flatMap((edit) =>
      edit && typeof edit === "object"
        ? fileChangesFromToolInput(toolName, edit as Record<string, unknown>)
        : [],
    );
  }
  return [];
}

export function fileChangesFromDiffs(raw: unknown): FileChange[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const rec = row as { file?: unknown; before?: unknown; after?: unknown };
    if (typeof rec.file !== "string" || rec.file.length === 0) return [];
    const before = typeof rec.before === "string" ? rec.before : undefined;
    const after = typeof rec.after === "string" ? rec.after : undefined;
    const kind: FileChangeKind =
      before === undefined || before.length === 0
        ? "add"
        : after === undefined || after.length === 0
          ? "delete"
          : "update";
    return [
      {
        path: rec.file,
        kind,
        ...(before !== undefined ? { oldText: before } : {}),
        ...(after !== undefined ? { newText: after } : {}),
      },
    ];
  });
}

export function isRewindStagingThread(threadId: string): boolean {
  return threadId.includes(":rewind:");
}

export function firstMessageAfterCheckpoint(
  messages: readonly { info?: { id?: unknown } }[],
  checkpointId: string,
): string | undefined {
  const index = messages.findIndex((message) => message.info?.id === checkpointId);
  if (index < 0) return undefined;
  const next = messages[index + 1];
  return typeof next?.info?.id === "string" ? next.info.id : undefined;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
