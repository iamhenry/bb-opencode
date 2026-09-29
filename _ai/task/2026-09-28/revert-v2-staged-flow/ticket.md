# Align Revert with OpenCode v2 staged flow and fix revert icon

Type: Feature

## Problem

Two gaps in the OpenCode BB thread UI:

1. **Wrong icon.** The "Revert from here" message action registers `icon: "Undo2"` (`app.tsx:51`). BB's host icon registry is HugeIcons; `Undo2` is a Lucide name the host does not know, so the action renders BB's generic fallback icon instead of a revert glyph. BB's extended icon set already ships the HugeIcons `ArrowTurnBackward` glyph (verified in the installed BB app bundle `icon-extended-CdKZK3gi.js`), so this is a one-string fix.

2. **Revert is v1 one-shot; OpenCode v2 is staged — rewind-to-checkpoint should work like native.** The plugin calls v1 `POST /session/{id}/revert` (`src/client.ts:376`) which truncates history and restores snapshots immediately, leaving no undo beyond the plugin's own projection. OpenCode v2 (installed binary v2.0.18) moved to a staged model and the plugin should adopt it:

   - `POST /api/session/:sessionID/revert/stage` `{ messageID, files? }` → `Revert.State { messageID, partID?, snapshot?, diff?, files? }` — sets/moves a reversible boundary, restores file snapshots up to that checkpoint, hides (does not delete) later messages.
   - `POST /api/session/:sessionID/revert/clear` — cancel: put files and history back exactly as before the revert.
   - `POST /api/session/:sessionID/revert/commit` — finalize: delete the staged messages for good (this is the "rewind" settlement).

   Live-verified on v2.0.18: all three endpoints exist and respond (unauth → 401 with Basic realm; bogus session → `InvalidRequestError: Invalid session ID`), with username `opencode` + `$OPENCODE_SERVER_PASSWORD` Basic auth per `packages/server/src/auth.ts` on `anomalyco/opencode` `dev`.

   Core semantics confirmed from `packages/core/src/session/revert.ts` and `packages/opencode/src/session/revert.ts` (same repo): stage plans file restores from per-message snapshots (`message.snapshot.files` → `Snapshot.restore`), records session `revert { messageID, partID, snapshot, diff, files }`, publishes Staged/Cleared/Committed events; unrevert restores the recorded snapshot. Works for git-tracked files natively via the snapshot system — no plugin-side git work.

3. **Revert button shows on LLM replies; native UIs are user-messages-only.** The plugin registers the `messageAction` for both roles, so assistant messages currently render a revert icon. Verified in both references: OpenCode's own app passes the `actions` prop (fork/revert) only to `UserMessageDisplay` — `AssistantMessageDisplay` receives no actions (`packages/session-ui/src/components/message-part.tsx:936-981`); OpenChamber passes `onRevert` only in its user-message branch (`packages/ui/src/components/chat/ChatMessage.tsx:782-889`).

## Reference implementations (studied, adapt don't copy)

- `anomalyco/opencode` (branch `dev`): `packages/schema/src/revert.ts` (Revert.State + FileDiff), `packages/core/src/session/revert.ts` (stage/clear/commit), `packages/opencode/src/session/revert.ts` (v1-compat revert/unrevert/cleanup), `packages/protocol/src/groups/session.ts` (endpoint shapes), `packages/server/src/handlers/session.ts`.
- `openchamber/openchamber`: `packages/ui/src/sync/session-actions.ts` — `revertToMessage` flow: read target message → restore prompt text/attachments to composer → cascade revert to descendant sessions → `stageRevert(sessionId, revertMessageID, { directory })` → refresh; staged dock offers Clear / Commit / fork-from-staged-message. Their dock: `packages/ui/src/components/chat/composer/ui/RevertedMessageDock.tsx`; message action button uses a back-arrow icon. Descendant cascade cutoff: a subagent run's report lands after its child already worked, so reverting the run reverts the child from its start — `descendantRevertCutoff` uses child session created time when the target carries a subagent run.
- **Where revert can be clicked** (verified in both): user messages only — assistant replies never receive the action. An LLM reply is rewound by reverting at its own user prompt, which hides the reply along with the turn. Neither UI uses OpenCode's `partID` mid-reply rewind either.

## BB-native support assessment

BB does not expose a revert/checkpoint API of its own for plugins. What BB does support natively:

- Provider capabilities declare `fork: "none" | "tip" | "checkpoint"` — "checkpoint" is exactly "recreate the session at an earlier point, which is what edit-past-message rewind needs". This plugin already declares `fork: "checkpoint"` in both `server.ts` (`bb.providers.register`) and the bridge handshake (`src/bridge.ts:2601`), and `thread/fork` is wired to OpenCode `session.fork` with a `messageID` checkpoint.
- Bridge request methods (`node_modules/@get-bb/plugin-sdk/dist/provider-bridge.js` `BRIDGE_REQUEST_METHODS`) include `threadFork` with `sourceProviderCheckpointId` but **no** `threadRewind`/`threadRevert` method — the staged-revert path must run through plugin host RPC (`revert` / `unrevert` handlers already exist in `host.ts`/`src/host-handlers.ts`), not through BB's provider-bridge methods.
- The plugin already hydrates checkpoint ids into the BB timeline (`providerCheckpointId` in `src/hydrate.ts`) and already projects staged/committed hidden rows onto timeline rows (`src/revert-projection.ts`, `src/app/revert-timeline.ts` sets `data-oc-reverted`).

**Assessment:** not hacky. This mirrors how OpenChamber does it (drive the OpenCode server API directly over the plugin's host RPC). The UX can reach OpenChamber/OpenCode-native quality: staged marker + dock with Restore (clear → back to exactly the pre-revert state) / Commit (finalize the rewind) / fork-from-staged-message. One note for later: a future BB-native `threadRewind` bridge method would let the host own more, but nothing in the staged flow *requires* it.

## Outcome (target UX)

Clicking "Revert from here" on a **user message** only (the action is removed from assistant messages):

- Abort the session if running, then stage the revert at that message: files roll back to the checkpoint state (git-safe), that prompt and everything after it hide immediately, prompt text returns to the composer.
- Dock shows the staged messages and offers: **Restore** (clear → session returns exactly to pre-revert state, composer restored), and Commit via re-send from the composer after staging, plus fork-from-staged-message where available.
- Reverting a subagent-run-carrying message cascades stage into the child sessions so nothing writes past the boundary.

**Assistant replies are not revert targets** — user messages only, native parity (decision made). The server-side normalization of assistant clicks to the user turn (`revert-target.ts`, `revert-projection.ts:26`) stays as a safety net, but the button/icon must be removed from LLM replies entirely.

## Definition of done

- [ ] "Revert from here" action shows the HugeIcons `ArrowTurnBackward` glyph (no generic fallback icon).
- [ ] Revert action renders on **user messages only** — no revert icon/button on assistant (LLM) replies (it currently appears on both).
- [ ] User clicks "Revert from here" on a user message in an idle OpenCode thread: that prompt and later messages hide, files in the workspace roll back to the checkpoint (verify with a real edit to a git-tracked file — `git diff` shows the file restored), prompt text re-appears in the composer.
- [ ] Same click while the session/stream is running: in-flight turn stops first, then staging happens; no orphaned cards.
- [ ] Dock "Restore" (clear) returns the thread to exactly the pre-revert state: hidden messages visible again, workspace files restored to pre-revert contents, composer back to its prior draft.
- [ ] Committing the rewind (via re-send from the composer after staging, or a dock Commit action) removes staged messages for good; timeline and history reflect the rewind; a fresh prompt continues after the checkpoint.
- [ ] Reverting a message containing a subagent run also stages the revert in the child session (child's messages past its start hidden per cutoff rule).
- [ ] Assistant replies are rewound via their user prompt; no reply-only partial revert, no hanging orphaned prompt.
- [ ] Works with BB message ids passed from the action (`message.id` + `message.text` path in `runMessageUndo`) without text-matching ambiguity on duplicate prompts — prefer exact messageID passthrough when the host can resolve it.

## Verification

- Verify on: a BB thread running OpenCode v2.x in this plugin (this machine), plus mechanical checks.
- Never: never run OpenCode `session.delete`, never touch git directly to fabricate state (revert flows restore via OpenCode snapshots; git only used read-only to observe file rollbacks), never spawn extra OpenCode servers.
- Icon — proof: hover a user message in a BB OpenCode thread, screenshot the action row — receipt: screenshot showing the back-arrow glyph.
- User-messages-only — proof: hover both a user message and an LLM reply; the revert icon shows only on the user message — receipt: screenshot of both action rows.
- File rollback — proof: make the agent edit a tracked file, click Revert from here on that user message, run `git diff` to show the file restored — receipt: terminal output.
- Restore (clear) — proof: revert, then Restore from dock, then `git diff` clean + timeline intact — receipt: screenshot + `git status`.
- Running-session revert — proof: start a long turn, click revert, observe settle-then-stage and no stuck spinner — receipt: screenshot of dock + timeline.
- Cascade — proof: turn that runs a subagent task, revert it, inspect child session message list — receipt: host RPC output.

## Scope

- **In:** revert action on user messages only (remove from assistant replies); revert action icon fix; host RPC `revert`→ v2 `revert.stage`, `unrevert`→ v2 `revert.clear`; new `revertCommit` RPC + contract entries (`contract.ts` both `hostContract` and `rpcContract`, `host.ts`, `server.ts`, `src/client.ts`, `src/host-handlers.ts`); revert dock Restore/Commit model (extends current undo/redo dock); subagent-run cascade stage; timeline projection already handles hidden rows — keep.
- **Out:** BB-native `threadRewind` bridge method (possible follow-up upstream request), TUI/desktop OpenCode UI changes, forking new BB threads from staged messages (v1 `forkFromMessage` stays as-is), any provider other than OpenCode.

## Evidence / media

- Screenshot (user-supplied): ![Revert from here tooltip on a BB user message showing the generic fallback icon instead of the revert glyph](https://github.com/user-attachments/assets/04170b05-2f6d-4ee0-9303-18a10f87d137) — the "Revert from here" tooltip on a BB user message, showing the generic/wrong icon (dark square) in the message action bar.

![Revert from here tooltip on a BB user message showing the generic fallback icon instead of the revert glyph](https://github.com/user-attachments/assets/04170b05-2f6d-4ee0-9303-18a10f87d137)

## Result (2026-09-29)

Shipped. Verified live in BB on disposable threads: back-arrow icon on user messages only; Revert hides the turn, rolls files back, refills the composer; Restore undoes it; **Confirm** (dock button, was "Commit") makes it permanent and the next prompt continues; revert while running stops first; subagent edits roll back with the parent.

How it works:
- Dock: Restore → OpenCode `revert/clear`; Confirm → `revert/commit` (`revertCommit` RPC). Staging → `revert/stage`.
- BB row → OpenCode message: row → BB turn → `turn/completed.providerCheckpointId` (the turn's first prompt ID). Fails closed if missing.
- Subagents: child sessions created after the target are staged/cleared/committed with the parent.
- Assistant-row button hide + icon swap live in `src/app/revert-timeline.ts` (BB SDK has no per-role action filter; icon comes from the plugin branding asset).

Bugs found only in live testing (keep in mind):
- BB icon asset URL has a `?h=` cache tag — match by prefix.
- Stopped turns must still carry `providerCheckpointId`, or revert says "Can't revert this older message".
- Subagent "[bb system] completed" notices arrive as user messages; the checkpoint must be the turn's first prompt, not the last user message.
- A thread's opening prompt row has `turnId: null`; map it to the next turn row.
- `threads.events.list` limit max is 100.

Known caveats:
- Already-running provider bridge processes keep old plugin code until restarted; test in a new thread.
- Subagent turns completed before this fix still point at the notice.
- After Restore, the draft stays in the composer.

