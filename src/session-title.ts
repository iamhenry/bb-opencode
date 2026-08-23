/** Matches OpenCode `Session.isDefaultTitle` (packages/opencode/src/session). */
const DEFAULT_TITLE =
  /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export function isDefaultOpenCodeTitle(title: string): boolean {
  return DEFAULT_TITLE.test(title);
}

/** OpenCode's first-turn title agent replaces this placeholder. Do not stamp it on BB. */
export function shouldPublishOpenCodeTitle(title: string): boolean {
  return title.length > 0 && !isDefaultOpenCodeTitle(title);
}
