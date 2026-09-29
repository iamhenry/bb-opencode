# Align Revert with OpenCode v2 staged flow and fix revert icon

### Executive Summary

#### What's broken?

The Revert action has the wrong icon, appears on assistant replies, can select the wrong OpenCode prompt when text repeats, and has no explicit Commit action or descendant-session cascade.

#### What's the fix?

Keep the existing v2 stage/clear path; hide this plugin's assistant-row action in its content script, guard assistant clicks, resolve the clicked BB row to its exact OpenCode user `messageID`, and add a separate Commit path with descendant cascade.

#### What happens after the fix?

- BB users can stage a rewind from a user prompt, see its turn and later rows hidden, and restore the staged state or commit it permanently.
- Reverting a prompt that started subagent work also stages, restores, or commits its descendant sessions at their child-start cutoffs.
- Assistant replies have no visible Revert action and cannot trigger a reply-only rewind.

#### What changes?

- `app.tsx` and `src/app/message-revert.ts`: supported back-arrow icon, user-only callback guard, and BB row identity forwarding.
- `src/app/revert-timeline.ts`: hide only this plugin's Revert action on assistant rows, using the actual BB markup and cleaning up on unmount.
- `contract.ts`, `host.ts`, `server.ts`, `src/client.ts`, `src/host-handlers.ts`, and `src/app/revert-dock.tsx`: typed `revertCommit` route and distinct Restore/Commit actions.
- Mapping, cascade, hydration, and projection helpers: exact row-to-provider identity and consistent descendant lifecycle.

#### What's the risk?

Assistant-button hiding depends on BB's rendered markup. Missing or ambiguous identity must stop before changing OpenCode or the BB projection. The BB composer API does not expose a complete structured-draft snapshot; preserve and verify the supported text and attachment state, and report richer draft limitations.

#### What's on me?

Implementation needs `npm ci` in this worktree. Live proof needs the exact built plugin loaded in BB, an already-running OpenCode v2 server, and an approved disposable thread; no new OpenCode server or Git mutation is permitted.

---

### Description

Implement the selected plugin-only staged flow from `issue.md#Judge Decision`. Keep BB row IDs for timeline projection and OpenCode user-message IDs for provider operations as separate values. The stage and clear calls already use OpenCode v2; do not rebuild that lifecycle. Add explicit OpenCode commit through a typed `revertCommit` RPC. Restore remains v2 clear. Cascade stage, clear, and commit through the target's descendant sessions using each child's start cutoff. Keep the existing projection for hiding BB timeline rows.

### Repair round 1

Apply only these three fixes to the current candidate (base `2e815b1` plus working tree):

1. **Revert click fails:** At `server.ts:1679`, request BB thread events with limit `100`, not `200`. BB rejects limits above 100; existing `afterSeq` pagination already handles the remaining events.
2. **Assistant-row action hiding:** The content-script selector `[data-message-role="assistant"]` does not match live BB rows. Use the observed `data-timeline-row-id` markup to identify assistant rows (`<threadId>:assistant:...`) versus user rows (`<threadId>:user-...`), and hide this plugin's “Revert from here” button on assistant rows only.
3. **Back-arrow glyph:** BB renders message-action icons from `bb.branding.icon` (live DOM: `span[data-plugin-icon-asset="/api/v1/plugins/opencode/assets/icon"]`) as a CSS mask, so `icon: "ArrowTurnBackward"` alone cannot change it. Inside only this plugin's “Revert from here” button, have the existing content script swap that span's mask image to a back-arrow glyph using a self-contained SVG data URL. Keep the OpenCode branding logo elsewhere; falling back to the logo if BB markup changes is acceptable.

### Current vs Target State Comparison

| Scenario | Current | Target |
| --- | --- | --- |
| Action | `Undo2` appears on user and assistant rows | `ArrowTurnBackward`; action hidden on assistant rows and callback guarded |
| Target identity | BB ID projects rows; provider target may use role/text matching | Validated exact OpenCode user `messageID`; fail closed without a unique correlation |
| Lifecycle | v2 stage/clear exists; dock says “Undo revert”; no explicit commit | Dock Restore calls clear; separate Commit calls OpenCode v2 commit |
| Descendants | No revert cascade | Descendant sessions stage/clear/commit at child-start cutoffs |
| Files | OpenCode snapshots restore files | Continue to use OpenCode snapshots; Git is observation-only |

### Acceptance Criteria

Carry-forward source: approved criteria in `issue.md` and Definition of Done in `ticket.md`; selected behavior is governed by `issue.md#Judge Decision`.

- [ ] **AC1 — Icon and role visibility:** The action displays a visible back-arrow glyph on user rows, and no “Revert from here” action appears on assistant rows in the real BB UI. Calling the action handler with an assistant row has no effect.
- [ ] **AC2 — Exact target:** Clicking a BB user row resolves to its exact OpenCode user `messageID`, including when prompts have identical text. Do not use text/fuzzy matching or an unverified ordinal. Missing or ambiguous correlation returns an error without staging or changing projection.
- [ ] **AC3 — Stage and restore:** On an idle OpenCode v2 thread, staging hides the clicked user prompt and later BB rows, restores a tracked file through OpenCode snapshots, and puts the prompt in the composer. Restore calls v2 clear and returns the provider history, tracked file, visible timeline, and supported prior composer draft state to their pre-stage values.
- [ ] **AC4 — Running turn:** If the session is running, stop and settle it before staging. The staged result has no orphaned prompt/reply cards or stuck spinner.
- [ ] **AC5 — Commit:** Dock Commit calls OpenCode v2 commit through the new typed `revertCommit` RPC, not clear or local projection alone. Staged messages are permanently removed from provider history, the projection remains committed, and a new prompt can continue from the checkpoint. Do not rely on sending a prompt to commit implicitly.
- [ ] **AC6 — Descendants:** A target carrying a subagent run stages all applicable descendant sessions at their child-start cutoffs. Restore clears the same staged descendants; Commit commits the same staged descendants. Operations keep provider state and BB projection consistent.
- [ ] **AC7 — Assistant safety:** Assistant replies are not direct targets. Preserve server-side normalization as a safety net so a reached assistant target resolves to its user prompt; never leave a reply-only rewind or orphaned prompt.
- [ ] **AC8 — Guardrails:** Revert operations never call OpenCode `session.delete`, never start an additional OpenCode server, and never mutate Git state. OpenCode snapshots own file restoration; Git status/diff are read-only evidence only.

### User Story

As a user in a BB OpenCode thread, I want to stage a rewind from the exact user prompt I select, then restore or commit it, so I can safely correct an earlier turn without losing the option to undo the rewind.

### Gherkin BDD Scenarios

#### Scenario: Stage, restore, then commit the selected prompt

Given an approved disposable BB thread attached to an existing OpenCode v2 server, with duplicate-text user prompts, a tracked file changed by the agent after the selected prompt, and a saved composer draft  
When I select Revert from here on one user prompt, Restore it, stage it again, and choose Commit  
Then only the exact selected provider prompt and later history are staged; Restore returns the prior history, tracked file, visible rows, and supported draft state; Commit removes the staged suffix and a new prompt continues from the checkpoint.

Acceptance Criteria References: AC2, AC3, AC5, AC8.

#### Scenario: Revert a running subagent turn

Given an approved disposable thread with a running turn that started descendant sessions  
When I select Revert from here on the originating user prompt  
Then the parent and descendants settle before staging at their child-start cutoffs, no orphaned cards remain, and the dock can Restore or Commit the same staged session set.

Acceptance Criteria References: AC4, AC6, AC7, AC8.

### Scope & Boundaries

#### In Scope

- [ ] Update the icon and hide this plugin's action on assistant rows through the user-approved content-script approach; guard assistant callbacks.
- [ ] Preserve separate BB row and OpenCode message identities; use validated exact correlation and fail closed when unavailable or ambiguous.
- [ ] Retain existing v2 stage and clear; add a separate `revertCommit` RPC across strict app/host contracts and client adapter.
- [ ] Make dock Restore call clear and add explicit Commit; keep projection updates aligned with successful provider results.
- [ ] Cascade stage, clear, and commit to descendants with child-start cutoffs; preserve settle-before-stage behavior.
- [ ] During Repair round 1, do not write regression tests. Only after independent QA passes, add the smallest regression tests that preserve the proven behavior.

#### Out of Scope

- BB SDK or host changes, other providers, OpenCode TUI/desktop changes, fork-from-staged-message, and replacing the existing v2 stage/clear flow.
- Git resets, checkouts, or other Git writes; OpenCode session deletion; starting extra OpenCode servers; dependencies or commits.

### Codebase Orientation

- Action registration and content-script mounts: `app.tsx:19-60`.
- Existing assistant click/action path: `src/app/message-revert.ts:4-24`; current row hiding/projection script: `src/app/revert-timeline.ts:1-108`.
- Typed app/host boundaries: `contract.ts:68-145, 229-385`; host dispatch: `host.ts` handlers; app RPC and projection flow: `server.ts:630-678, 1658-1776`.
- OpenCode lifecycle adapter: `src/client.ts:35-113, 417-423`; stage/clear handler and settle logic: `src/host-handlers.ts:214-291`.
- Existing mapping and projection helpers: `src/revert-target.ts`, `src/revert-projection.ts`, `src/hydrate.ts`; task/child context: `src/task-live.ts`, `src/bridge.ts`.
- Dock: `src/app/revert-dock.tsx`; focused tests include `tests/revert-target.test.ts`, `tests/revert-projection.test.ts`, `tests/revert-state.test.ts`, `tests/revert-registration.test.ts`, `tests/hydrate.test.ts`, and `tests/v2-map.test.ts`.

### Data Flow

BB click passes its row ID and role to the app RPC. The server keeps that BB ID for row projection and resolves a validated correlation to the exact OpenCode user `messageID`; ambiguity fails before mutation. The host uses the typed OpenCode client to stage/clear/commit the parent and applicable descendants. Successful provider results update the BB projection and notify the dock/content script. The dock restores composer state on clear and permanently commits only through the explicit Commit action.

### Dependencies

- No new dependencies. Use the pinned OpenCode v2 client and BB plugin SDK already declared in `package.json`.
- This worktree has no `node_modules`. Before checks, run `npm ci` here using the checked-in `package-lock.json`; do not rely on dependencies installed in the original checkout.
- Live verification requires BB to load this exact worktree build and an already-running OpenCode v2 server. If either is unavailable, do not start another server; report the verification as blocked.

### Deliverables

- Repair round 1 changes to `server.ts` and the content script. After independent QA passes, a follow-up adds the smallest regression tests that preserve the proven behavior.
- Mechanical check output and live smoke receipts under `_ai/task/2026-09-28/revert-v2-staged-flow/verification/`.

### Error Handling and Risks

- **No exact row correlation:** return `{ ok: false, error }`; do not stage, clear/commit another target, or change the projection. Never fall back to matching prompt text or ordinal position.
- **Assistant action invoked:** stop in the app callback. If an assistant target reaches the server through another path, normalize to its preceding user prompt and keep projection aligned; do not create a reply-only boundary.
- **Service/API unavailable:** surface a bounded error and retain existing projection. Attach only to the existing server; do not spawn another server as recovery.
- **Busy or failed descendant operation:** settle descendants before mutating; stage descendants before the parent. Do not publish success until all requested provider operations succeed. If partial work fails, attempt clear on sessions already staged and report any cleanup failure without hiding it.
- **Content script markup changes:** scope hiding to the actual assistant row and this plugin's action only; observe DOM updates and restore modified visibility on unmount. Verify against the real BB markup.
- **Composer limits:** retain the current per-thread text draft behavior and verify attached files remain intact. The installed composer API does not guarantee restoration of arbitrary structured draft state; record this limitation rather than claiming it was proven.
- **Snapshot ordering:** rely on OpenCode snapshots, not Git writes. Stage descendants before the parent and use the same descendant set for clear/commit.

---

### Implementation Checklist

#### Phase 1: Repair the current candidate

Build implements only the three items in Repair round 1. The existing staged-flow implementation is already on the candidate; do not redo or expand it in this repair.

**Task 1 — Apply Repair round 1**

- [ ] UPDATE: Apply the three fixes listed in Repair round 1 to the current candidate (`2e815b1` plus working tree), without unrelated changes.

**Task 2 — Run mechanical checks only**

- [ ] CONFIG: Run `npm ci` in this worktree before checks; `node_modules` is absent here.
- [ ] TEST: Run `npm run typecheck`, the existing `npm test` suite, and `npm run build`; all must exit 0 on this candidate.
- [ ] NOTE: Build does not perform live verification and writes no new regression tests in this round.

#### Phase 2: Independent real-UI QA

- [ ] VERIFY: After Phase 1 passes, an independent `verification-gate` pass proves the repaired candidate through the real BB/OpenCode path below. QA runs before any new regression tests are written. Mechanical checks do not replace live proof.
- [ ] CAPTURE: Save short recordings for Revert → Restore and Revert → Commit → new prompt continues. Screenshots of the user and assistant rows are sufficient for the icon and role check.

#### Phase 3: Post-QA regression tests and review

- [ ] TEST: Only after independent QA returns PASS, Build adds the smallest regression tests preserving the QA-proven behavior (for example, a guard that requests no more than 100 thread events).
- [ ] REVIEW: After those tests are added, obtain a brief independent reviewer check of the tests.

#### Phase 4: Commit Changes

Not authorized by this plan. Do not commit, push, or open a PR unless separately authorized after both gates pass.

### Verification Target

- **Platform:** `desktop` — the real BB app/thread UI on this machine.
- **Objective:** On the exact built candidate, selecting a user row shows a visible back-arrow glyph and stages that exact OpenCode user message and its applicable descendants; assistant rows show no action. Restore clears the same boundary, while Commit permanently finalizes it.
- **Falsifier:** The user action lacks the visible back-arrow glyph, the action appears on an assistant row, duplicate text selects a different provider message, a stage/clear/commit changes the wrong session/history/file, cascade omits or misplaces a descendant cutoff, or the UI/projection reports success without the corresponding OpenCode state.
- **Primary Flow:** Run `npm ci`, `npm run build`, and record the worktree revision plus built artifact identity. Load that exact artifact through BB's normal plugin-loading path in the existing BB app; use an already-running OpenCode v2 server and an approved disposable thread. Do not use the original checkout's build, start/restart/spawn an OpenCode server, or mutate Git. Capture a read-only baseline, create duplicate prompts and a tracked-file edit through the agent in the disposable thread, save a plain-text composer draft (and attachment if available), then: (1) hover user and assistant rows; (2) select one of the duplicate user prompts and observe staged rows, file, and composer; (3) Restore and compare to baseline, recording a short `videos/revert-restore.webm`; (4) stage the same target again, Commit, inspect provider history, and send one fresh prompt, recording a short `videos/revert-commit-prompt.webm`. Separately use the same approved runtime for one running-turn revert and one subagent-cascade stage/Restore/Commit. Require explicit operator permission before mutating a shared thread; if no disposable thread or permission exists, stop as blocked.
- **Regression Check:** Verify the action remains inert on a non-OpenCode thread and that the content script restores its DOM changes when unmounted/thread context changes. Verify duplicate-text selection from the actual UI, not only a helper test.
- **Mechanical:** Build's first pass runs `npm ci`, `npm run typecheck`, the existing `npm test` suite, and `npm run build` in this worktree; all must exit 0. Build writes no new regression tests before QA. Only after QA PASS, the follow-up Build step adds the smallest regression tests, then a brief independent reviewer checks those tests. Build receipt identifies the exact candidate. Use only read-only `git status` / `git diff` for file-state observations.
- **Observable:** Retain app-owned evidence under `_ai/task/2026-09-28/revert-v2-staged-flow/verification/`: `screenshots/icon-user-row.png` and `screenshots/icon-assistant-row.png` are sufficient for the back-arrow glyph and user-only action check; `screenshots/staged-state.png`, `screenshots/restored-state.png`, `screenshots/committed-state.png`, `screenshots/cascade-state.png`; short `videos/revert-restore.webm` and `videos/revert-commit-prompt.webm`; and `receipts/file-rollback.txt`, `receipts/restore-baseline.txt`, `receipts/duplicate-target.txt`, `receipts/commit-history.txt`, `receipts/cascade-sessions.txt` for read-only Git/provider observations. A screenshot/video must show the real BB UI; command output is corroboration, not UI proof.
- **Pass Criteria:** Mechanical commands exit 0 on the exact worktree candidate. Real BB screenshots show a visible back-arrow glyph on user rows and no Revert action on assistant rows. The duplicate-text click selects the exact clicked OpenCode `messageID`; no ambiguous case mutates state. Stage visibly hides the selected prompt and suffix, restores the tracked file through OpenCode snapshots, and restores the prompt to the composer. Restore returns history, file, timeline, and supported draft state to baseline. Commit uses the provider commit endpoint, permanently removes the staged suffix, and permits a fresh prompt from the checkpoint. Running revert settles before stage with no orphaned cards. Cascade applies the correct child-start cutoff and the same descendant set for Restore and Commit. Git receipts are read-only observations. No `session.delete` or extra server is used.
- **Blocked Conditions:** No existing healthy OpenCode v2 server; inability to load/identify this exact worktree build in BB; missing real BB action/row markup or plugin action identity; no approved disposable thread/permission for an agent-made tracked edit, running turn, duplicate prompts, or subagent run; missing/ambiguous historical row correlation; unavailable cascade history; or missing evidence tooling. The implementation/operator owns runtime and thread authorization; unlock by providing an existing server, exact-candidate activation path, approved disposable thread, and required UI/runtime access. Do not recover by spawning a server or mutating Git.

### Manual QA Checklist

- [ ] Confirm the live BB thread uses the exact plugin artifact built from this worktree and the already-running OpenCode v2 server.
- [ ] Confirm permission to use the disposable thread and its tracked-file/subagent test actions; capture its pre-test provider/history and read-only Git baseline.
- [ ] Confirm the supported composer text/attachment state returns after Restore; note unsupported richer draft state without claiming it was restored.
- [ ] Confirm verification receipts are saved under the named `verification/` paths before reporting a PASS.

## Plan Judge

- Decision: `APPROVE_PLAN`
- Score: 94
- Chosen proposal: Plugin-only staged revert with user-approved content-script role hiding and icon swap, exact provider-message correlation, explicit Commit, and descendant cascade.
- Checked: `issue.md`, `plan.md`, `research/code-archaeology.md`, `research/dependency-map.md`, `research/ux-behavior.md`, `research/style-fingerprint.md`, `research/external-signal.md`, `verification/result.md`, `verification/receipts/action-row-observation.txt`.

### Notes

- Repair round 1 names all three observed failures and concrete locations or markup: cap events at 100, classify the actual timeline row IDs, and replace only this action's icon mask. These changes follow the binding user decisions.
- Build performs mechanical checks but not its own live verification; independent QA precedes new regression tests. The verification target retains real BB UI evidence for the repaired action and full staged lifecycle.
- Exact identity remains fail-closed; historical rows without provable correlation are blocked rather than matched by text.

### Required Changes

- None
