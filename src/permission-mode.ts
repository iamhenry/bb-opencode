const MODES = ["accept-edits", "auto", "full"] as const;
export type LivePermissionMode = (typeof MODES)[number];

const LABELS: Record<string, LivePermissionMode> = {
  "accept edits": "accept-edits",
  "approve for me": "auto",
  "full access": "full",
};

export function parsePermissionMode(value: unknown): LivePermissionMode | undefined {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
    ? (value as LivePermissionMode)
    : undefined;
}

export function permissionModeFromExactLabel(
  text: string | null | undefined,
): LivePermissionMode | undefined {
  if (!text) return undefined;
  return LABELS[text.replace(/\s+/g, " ").trim().toLowerCase()];
}

/** One unique footer label wins. Several different labels = open menu; skip. */
export function pickVisiblePermissionMode(
  labels: readonly string[],
): LivePermissionMode | undefined {
  const found = new Set<LivePermissionMode>();
  for (const label of labels) {
    const mode = permissionModeFromExactLabel(label);
    if (mode) found.add(mode);
  }
  return found.size === 1 ? [...found][0] : undefined;
}
