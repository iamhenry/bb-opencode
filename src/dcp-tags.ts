/**
 * OpenCode DCP (`@tarquinen/opencode-dcp`) tags context messages with `@N@` and
 * models echo the next one at the end of their reply. DCP V1 cleaned that up in
 * `experimental.text.complete`; its V2 entry only cleans input, so the echo is
 * stored and would show as a stray paragraph. Same tag shape as DCP's compact
 * `COMPACT_TAG_REGEX`. Only a *trailing* tag is removed, so prose that quotes
 * a tag mid-text stays intact.
 */
const TAG = String.raw`@(?:[1-9]\d*|b[1-9]\d*|blocked)@(?:[ \t]+\[(?:low|medium|high)\])?`;
const TRAILING_TAGS = new RegExp(String.raw`(?:\s*${TAG})+\s*$`, "i");
// A tail that could still grow into a tag while streaming ("@", "@1", "@10@", "@b", ...).
// Starts at the "@" (never eats earlier whitespace) so the visible text only ever grows.
const POSSIBLE_TAG_TAIL =
  /(?:@[a-z0-9]{0,8}@?(?:[ \t]+\[[a-z]{0,6}\]?)?\s*)+$/i;

/** Final text: drop echoed DCP tags at the very end. */
export function stripTrailingDcpTags(text: string): string {
  return text.replace(TRAILING_TAGS, "");
}

/** Streaming text: hide a tail that might be (part of) a trailing DCP tag until the stream closes. */
export function visibleStreamingText(text: string): string {
  return text.replace(POSSIBLE_TAG_TAIL, "");
}
