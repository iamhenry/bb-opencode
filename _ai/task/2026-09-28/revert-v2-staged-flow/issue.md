# Issue intake — Revert aligned with OpenCode v2 staged flow

## Original GitHub Issue

- Issue: [iamhenry/bb-opencode#29](https://github.com/iamhenry/bb-opencode/issues/29)
- Classification: **feature**
- Requested outcome: replace the plugin's v1 one-shot revert with OpenCode v2's reversible staged-revert lifecycle, make revert available on user messages only, use BB's supported back-arrow glyph, restore the target prompt to the composer, support clear/commit and subagent cascade, and preserve exact BB message-to-OpenCode message mapping. Full ticket text and supplied evidence are in [`ticket.md`](ticket.md).

## Acceptance Criteria

- The revert action uses the BB HugeIcons `ArrowTurnBackward` glyph and appears on user messages only.
- In an idle thread, selecting a user message stages the revert: the target prompt and later messages hide, tracked workspace edits roll back through OpenCode snapshots, and the prompt text returns to the composer.
- In a running thread, the active turn stops before staging; no orphaned cards remain.
- Restore clears the staged revert and restores the pre-revert history, file contents, and composer draft.
- Committing the rewind permanently removes staged messages; the timeline and history reflect it, and a new prompt can continue from the checkpoint.
- Reverting a message carrying a subagent run stages the appropriate child-session revert at the child's start cutoff.
- Assistant replies are not revert targets; the server-side normalization remains as a safety net.
- The action's BB message id resolves to the exact OpenCode `messageID`, including when prompt text is duplicated.

## Gherkin Happy Path

### Happy Path: Stage and restore a user-message revert

Given an idle OpenCode v2 thread with a user prompt, later messages, and a tracked file changed after that prompt  
When the user selects **Revert from here** on that user prompt  
Then the target prompt and later messages are hidden, the file returns to its checkpoint contents, and the prompt text appears in the composer; selecting **Restore** returns the history, file, and prior composer draft to their pre-revert state.

## Gherkin Edge Path

### Edge Path: Revert while a turn is running

Given an OpenCode v2 thread with a turn still running and a user prompt selected as the revert target  
When the user selects **Revert from here**  
Then the in-flight turn stops before the revert is staged, and the timeline shows no orphaned message cards.

## Current UX

- BB currently renders the global “Revert from here” action on user and assistant messages. It uses `Undo2`, which the host does not recognize and displays as a generic icon.
- The issue's “v1 one-shot” description is stale for this candidate: plugin code already calls OpenCode v2 stage and clear. After stage, its dock displays hidden-message previews, returns the target prompt text to the composer, and offers “Undo revert”; there is no dock Commit button.
- A running OpenCode session is aborted and the BB thread is allowed to settle before staging. This is source evidence only; no live UI was exercised during intake.
- The BB id finds the hidden BB timeline suffix, but the provider message is selected by role/text unless an OpenCode `messageID` is passed. Duplicate prompt text can fail as ambiguous.

## Post-change UX

- The target experience is user-message-only, with a real back arrow. Stage hides the selected prompt and later messages, restores tracked files from OpenCode snapshots, and puts the prompt in the composer. Restore brings history/files/draft back; Commit finalizes the hidden suffix; a subagent-run target stages its descendants too.
- **Supported-API blocker:** the pinned BB SDK's global message-action slot has no role filter. The separate `ThreadChatMessageAction` has `roles`, but this plugin registers a global action for the native thread timeline. Without a BB SDK change, the plugin cannot hide the action on assistant messages through the supported public API.
- The SDK message reference exposes BB `id`, role, text, and `sourceSeqEnd`, but not an OpenCode messageID. The current plugin passes BB `id` for projection and resolves the provider target using text; exact duplicate-prompt mapping is not implemented.
- The BB composer API supports text replacement/focus and preserves attachments, but does not expose a whole structured-draft snapshot. Exact restoration of every structured draft state is not guaranteed.
- The v2 commit endpoint is distinct from clear. This research did not prove whether submitting a new prompt commits an already-staged revert on the exact installed 2.0.18 path; an explicit dock Commit path is the clearest supported behavior to verify.

## Current Behavior

- App action -> `runMessageUndo` -> `undo` plugin RPC -> `revertThread` -> host `revert` RPC -> `resolveRevertMessageId` -> SDK stage. The action sends `messageId`, role, and text, not an OpenCode messageID. `revertState` reads `session.revert`; v2 revert events become generic `session.updated`, then the bridge rereads the session cursor.
- Existing stage/clear and the BB suffix projection work through separate paths. The dock polls/realtime-refreshes provider state, while a content script applies hidden-row ids. The server may commit its local projection when provider state becomes inactive; that is not itself an OpenCode commit call.
- The plugin can list direct child sessions by `parentID` and has short-lived live task-child bookkeeping, but has no cascade revert implementation.

## Constraints

- Do not mutate git state; OpenCode snapshots own file rollback.
- Keep all stage/clear/commit calls on the plugin host through the existing typed `OpenCodeClient` adapter and strict host/RPC contracts.
- Keep the v2 reversible boundary semantics distinct: clear restores; commit finalizes.
- Preserve append-only BB timeline behavior by retaining the existing projection rather than deleting or replaying provider rows.
- No OpenCode session deletion, extra server, or other-provider behavior is in scope.

## Style Rules

- Follow the current TypeScript ESM style, 2-space indentation, strict Zod RPC contracts, and typed `OpenCodeClient` adapter.
- Keep UI work in `src/app/*`, host/session operations behind `host.ts` and `src/host-handlers.ts`, and reusable pure mapping logic in `src/*` helpers.
- Preserve small `{ ok, error }` RPC results and focused Vitest behavior tests. Do not add dependencies.

## Blast Radius

- Likely local files: `app.tsx`, `contract.ts`, `host.ts`, `server.ts`, `src/client.ts`, `src/host-handlers.ts`, `src/app/message-revert.ts`, `src/app/revert-dock.tsx`, plus message-id mapping/cascade helpers and their tests.
- External dependency: a supported role filter on BB's global `messageAction` needs an SDK/host change outside this plugin repo. DOM-based hiding would be unsupported and brittle.
- Main risks: wrong provider boundary from text matching; staged provider state diverging from BB's row projection; file-snapshot ordering across child sessions; incomplete draft restoration; and claiming the resend path commits without proof.

## External Signal

- OpenCode `dev` exposes separate `stage`, `clear`, and `commit` endpoints; only stage has a JSON response (`{ data: Revert.State }`), while clear/commit are no-content successes. `Revert.State` contains the checkpoint and optional snapshot/diff/file metadata. See [session protocol](https://github.com/anomalyco/opencode/blob/dev/packages/protocol/src/groups/session.ts#L256-L289) and [revert schema](https://github.com/anomalyco/opencode/blob/dev/packages/schema/src/revert.ts).
- Snapshot-backed stage/clear does the workspace restore in OpenCode; plugin-side git work is not needed. OpenCode Basic auth is enabled only with a server password, uses configured username or `opencode`, and accepts a Basic Authorization header. See [core revert](https://github.com/anomalyco/opencode/blob/dev/packages/core/src/session/revert.ts), [auth](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/auth.ts#L20-L62), and [middleware](https://github.com/anomalyco/opencode/blob/dev/packages/server/src/middleware/authorization.ts#L9-L55).
- OpenChamber is a useful flow reference: it restores the prompt, handles child sessions, stages descendants before the parent, and offers explicit Clear/Commit. See [session actions](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/sync/session-actions.ts#L443-L518) and [dock](https://github.com/openchamber/openchamber/blob/main/packages/ui/src/components/chat/composer/ui/RevertedMessageDock.tsx#L1-L180).
- BB's global action type has no `roles` member; component-scoped `ThreadChatMessageAction` does. The BB icon registry includes `ArrowTurnBackward`. See [global action](https://github.com/get-bb/bb/blob/main/packages/plugin-sdk/src/app-contract.ts#L1740-L1757), [ThreadChat action](https://github.com/get-bb/bb/blob/main/packages/plugin-sdk/src/app-contract.ts#L2593-L2615), and [icon registry](https://github.com/get-bb/bb/blob/main/packages/shared-ui/src/components/ui/icon-registry.ts#L4-L20).

## Research Index

Reports and line-cited details:

- [Code archaeology](research/code-archaeology.md) — end-to-end local action/RPC/provider flow, v2 API request/response/auth, state/events, composer, and existing tests.
- [Dependency map](research/dependency-map.md) — callers, producers/consumers, blast radius, and regression probes.
- [UX behavior](research/ux-behavior.md) — current and intended user-visible behavior, with API gaps.
- [Style fingerprint](research/style-fingerprint.md) — local implementation conventions.
- [External signal](research/external-signal.md) — OpenCode, OpenChamber, and BB SDK reference evidence.

## Approaches

Ranked by fit and minimality:

1. **Preferred for the full stated outcome: add role filtering to BB's global `messageAction` API, then adapt the existing plugin flow.** The SDK/host should accept `roles: ["user"]` for global actions; the plugin then sets that option, changes `Undo2` to `ArrowTurnBackward`, adds a distinct v2 commit RPC/client method and dock action, resolves the selected BB message to its exact OpenCode checkpoint, and cascades lifecycle operations to the target's descendants. Reuse the existing stage/clear client adapter, revert-state polling, and timeline projection. Regression probes: only user rows show the action; duplicate prompts stage the clicked message; stage/clear/commit each match file/history/composer receipts; cascade is reversible. This requires an upstream BB SDK/host scope change, which is outside the current plugin-only repository.
2. **Plugin-only fallback if the upstream scope cannot expand:** fix the icon and implement commit/id/cascade work, while guarding assistant clicks in the callback. This prevents an assistant click from mutating history but leaves the assistant icon visible, so it explicitly does **not** meet the ticket's user-only visibility criterion. Use only if that criterion is relaxed.

Do not recommend content-script DOM removal for the assistant button: it would depend on BB's private markup and is not a supported API. The current plugin already uses v2 stage/clear; redoing that path would add no value. Before implementation, confirm the message-ID mapping strategy and test whether submit-after-stage commits on installed OpenCode 2.0.18.

## Judge Decision

Status: SELECTED
Selected Approach: Plugin-only staged flow with user-approved content-script role hiding, exact checkpoint mapping, and explicit Commit
Confidence: Medium

Scores:
- Upstream global-action role filter plus plugin changes: 68/100 - clean supported API, but requires an out-of-scope BB SDK/host change and cannot ship from this repository alone.
- Original plugin-only fallback (callback guard only): rejected - leaves the assistant button visible, failing the user-only acceptance criterion.
- User-approved plugin-only content-script variant: 84/100 - meets the visible outcome using the existing projection script, with accepted private-markup coupling and a fail-closed identity rule.

Decision:
- Select the user-authorized variant: extend the existing timeline content script to hide this plugin's Revert button on assistant rows, while the action callback rejects/normalizes assistant clicks. This overrides the stale warning in Approaches; the installed and latest SDK lack a global-action role filter (ticket.md:84-95; research/dependency-map.md:24-25; src/app/revert-timeline.ts:29-36).
- Resolve the clicked BB row to an OpenCode **user messageID** through an explicit, validated BB-turn/provider-message correlation, using existing timeline/checkpoint evidence or recording the correlation at bridge ingestion. Preserve the BB row id separately for projection; never choose between duplicate prompts by text, fuzzy match, or unverified ordinal alone. If historical data cannot establish a unique mapping, fail closed rather than stage the wrong turn (research/code-archaeology.md:5-9; research/dependency-map.md:13-14; src/hydrate.ts:135-173).
- Add an explicit dock Commit action through the existing typed host/client path. Keep Restore as clear; do not assume resend commits on installed 2.0.18 without proof. Retain existing stage/clear and row projection, and cascade to descendants with child-start cutoff and reversible clear/commit (ticket.md:49-59; research/dependency-map.md:15-18; research/external-signal.md:3-6).
- Verify button visibility against real BB markup and exact duplicate-prompt selection; the accepted markup coupling and the SDK's text-only composer restoration remain documented risks (research/ux-behavior.md:13-16).

Question:
N/A
