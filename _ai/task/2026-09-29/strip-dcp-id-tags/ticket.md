# Strip stray DCP message-ID tags from assistant replies

## Problem
Since the OpenCode V2 migration, assistant replies in BB end with a stray paragraph like `@10@`, `@12@`, `@17@`.

## Cause (evidence)
- `@tarquinen/opencode-dcp` 3.2.0 tags every context message with `@N@` (compact format) and tells the model not to output them.
- Models still echo the next tag at the end of their reply (`\n\n@10@`). OpenCode stores it: `session_message` for `ses_f14b14351ffe7wx9wBjkZ3NYMx` ends in code points `a a 40 31 30 40`.
- DCP v1 removed echoes with the `experimental.text.complete` hook (`stripHallucinationsFromString`). DCP's V2 entry (`lib/v2/index.ts` `setup`) only strips the *input* (`ctx.session.hook`), so nothing cleans the *output*.
- bb-plugin-opencode mirrors the stored text verbatim (live `session.next.text.*` -> `mapPartDelta`/`closeText`; history -> `hydrateDeltas` -> `closeText`).
- Scale: 56 of 23,527 assistant text parts, all on 09-28/09-29; 53 at the very end.

## Desired outcome
No `@N@` / `@bN@` DCP tag is shown at the end of an assistant reply, live or after reload. Other text is unchanged. Nothing is flashed during streaming.

## Change
Trailing-tag-only stripping (DCP's own `COMPACT_TAG_REGEX` shape) in the plugin's text mapping: hold back a possible tag tail while streaming, and strip a complete trailing tag on close/hydrate. Mid-text mentions of `@12@` stay (legit prose).

## Exit criteria
1. Baseline replay of the real session text through the plugin shows the tag in output (>0 hits).
2. After the fix: 0 tag hits in streamed deltas, closes, and hydrate; all other text byte-identical.
3. Existing `npm test` and `tsc --noEmit` pass.

## Not covered / follow-up
- BB's already-stored event history for old threads still holds the tag (plugin cannot rewrite it).
- Upstream: DCP V2 needs an output-side strip; worth an issue on Opencode-DCP/opencode-dynamic-context-pruning.

## Result (2026-09-29)
- Baseline replay (53 real tagged replies + 200 untagged controls, streamed at 1/3/64-char chunks + hydrate): 159 stream leaks, 159 close leaks, 53 hydrate leaks.
- After fix: 0 leaks, 0 text mismatches (759 stream runs, 253 hydrate runs). `tsc --noEmit` clean; `npm test` 394/394.
- Files: `src/dcp-tags.ts` (new), `src/map-delta.ts` (`mapPartDelta` text branch + `closeText`), `tests/map-delta.test.ts` (3 tests; 2 fail without the fix).
- Not verified: live BB UI on the installed plugin (fix lives in this worktree only, not merged/installed).
