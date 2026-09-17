# Explicit OpenCode steer delivery

## Problem

When a user steers an active OpenCode thread, the correction can be stored before the old next tool starts yet still wait until that tool finishes. The user sees the old work continue instead of an immediate change of direction.

The manual QA run in `thr_qje5cn5enq` disproved the initial wire-field-only fix. The correction was stored at `1789666802911`, but the old `sleep 20` tool started at `1789666803883` and ran to completion. The later breakfast response proved eventual delivery, not steering before the next tool.

A second manual run also disproved abort/restart without workspace routing. The correction was stored at `1789667541149`, about 1.8 seconds after `sleep 20` started, but the tool still completed at `1789667559448`. OpenCode's official abort route requires a workspace-routing query. The client omitted that directory, so the targeted correction now routes every abort through the bound session directory before restarting the corrected prompt.

## Acceptance criteria

- Inject-mode `turn/steer` prevents an old pending or running action from continuing past the correction.
- The correction becomes the next model action in the same BB turn.
- Queue-mode behavior remains unchanged.
- Regression coverage distinguishes immediate steering from eventual follow-up delivery.
- A fresh BB thread demonstrates that a correction sent before the old next tool starts prevents that tool from running.

## Verification

- Run the targeted bridge test, typecheck, and build.
- In a disposable BB thread, start a bounded delayed task, send a correction while it is active, and inspect the thread timeline plus OpenCode session records. The old delayed tool must not start after the correction is stored.

## Bounded debugging contract

- Pass only if a correction interrupts `sleep 20` within 3 seconds, the corrected response starts before the original 20-second deadline, and no dinner output appears.
- Run at most two evidence-driven implementation iterations from the workspace-routing candidate.
- Each iteration must test one hypothesis and add a new timing or abort-result signal. Stop early if it does not.
- If OpenCode reports a successful routed abort while the tool continues and no narrower plugin fix remains, stop as blocked at the OpenCode runtime boundary.
- Temporary diagnostics may contain only timestamps, session IDs, workspace routing, abort results, and restart timing. Never log prompt contents.

## Scope

Change only active steering and its adjacent regression coverage. Abort/restart is allowed if the official BB and OpenCode contracts show that legacy sessions cannot preempt a pending action through prompt delivery alone. Do not add a new UI status or queued-delivery redesign. Do not commit or push unless the user asks.

## Bounded debugging result

`BLOCKED` at the legacy OpenCode runtime boundary after the two allowed iterations.

- Iteration 1, `thr_xqhtyxz3x3`, session `ses_f4f75deb5ffeBGNfXjL8uYUZl2`: routed abort stopped `sleep 20` after about 1.7 seconds and OpenCode completed the assistant message with `MessageAbortedError`. The immediate restart created no correction user message and BB recorded no final output.
- Iteration 2, `thr_mce4v55a6a`, session `ses_f4f73ae4fffe88hl8EE19Mbk2a`: waiting until `sessionIsRunning` returned false before restart stopped the tool after about 0.6 seconds, but again created no correction user message and BB recorded no final output.
- The tested legacy API paths can provide eventual follow-up delivery without preemption, or preemption without a reliable corrected restart. Neither meets the acceptance criteria.
- No third plugin variation is justified by the evidence. The next investigation must target an upstream-supported atomic interrupt-and-resume contract or a full OpenCode V2 session migration.

## Persist-abort-replay refinement

Official OpenCode source exposes a narrower legacy sequence that the prior attempts did not test. A synchronous prompt with `noReply: true` persists caller-owned message and part IDs without joining the active runner. Replaying those same IDs is idempotent because OpenCode upserts messages and parts by ID.

The authorized sequence is therefore:

1. Persist the correction with stable message and part IDs and `noReply: true`.
2. Abort the active runner using the bound workspace directory.
3. Wait for the runner to release.
4. Replay the exact same IDs without `noReply` to start the corrected run.

Run at most two evidence-driven live iterations. Stop for reconsideration if the second distinct attempt still fails any condition: the old tool stops within 3 seconds, replay starts the corrected response before the original 20-second deadline, no old dinner output appears, and the database contains exactly one correction message and one row per stable part ID. On success, remove temporary diagnostics. On a stopped result, leave the best instrumented candidate loaded for inspection. Never log prompt contents.

## Persist-abort-replay result

`STOPPED` after the two authorized live iterations. The instrumented candidate remains loaded with steer-on-Enter enabled.

- Iteration 1, `thr_7zukjgcgsf`, session `ses_f4f61921cffeZMmCibZfchu5Br`: the correction persisted once, abort stopped the old tool within about 10 ms of persistence, but replay never started. OpenCode 1.18.31 emits both `session.status: idle` and `session.idle` for one abort; the bridge suppressed only one and closed the BB turn before replay.
- Iteration 2, `thr_mq6k9zeh8k`, session `ses_f4f5eb5f4ffetR8zj8Uuy39vtH`: suppressing both documented idle events allowed replay to start a second OpenCode loop at `1789669760942`. The plugin then issued another cancel at `1789669760943`, and the corrected assistant message ended immediately with `MessageAbortedError` and no output.
- Persistence remained idempotent: the database contains one correction message and one correction part. No old dinner output appeared.
- The remaining failure is BB live-turn ownership disappearing across the expected abort boundary. The post-replay stop-overlap guard interprets that as a real stop and aborts the newly started corrected loop. This needs reconsideration of the ownership/boundary state machine before another code change.

## Ownership refinement contract

Run an extremely tight two-run loop without writing regression tests first.

1. Add one post-replay diagnostic containing only session and ownership state: whether the live-turn map still points to the same object, whether either object has `stopping` or `parentBoundaryEmitted`, and whether session identity changed.
2. Run one live steer to identify exactly which predicate invalidates ownership.
3. Apply one targeted transition-state fix that preserves an expected steer handoff but still lets a real `thread/stop` cancel it.
4. Run one live verification. Write regression coverage only after that real flow passes.

Stop for reconsideration if the first run is ambiguous, more than one ownership cause is present, or the verification still fails. Never log prompt contents. Success requires the old tool to stop within 3 seconds, one correction message and part, a completed corrected response before the old 20-second deadline, no old dinner output, and no post-replay self-abort.

## Ownership refinement result

`STOPPED` at the diagnostic boundary. No transition-state fix or additional live run was attempted.

- Diagnostic run `thr_6g8kwtyq6r`, session `ses_f4f4fb937ffeS0JQ3o4CEg3REl`, reconfirmed the known sequence. The correction persisted once, the old tool stopped, the corrected loop started, and the plugin cancelled that corrected loop about 2 ms later.
- The ownership diagnostic was written to the provider bridge's in-memory debug ring. `bb opencode logs` executes its host handler in a different plugin process, so it returned no provider-process ring entries. A read-only search found no persisted copy of the diagnostic.
- The exact failed ownership predicate is therefore unavailable. This meets the contract's ambiguous-diagnostic stop condition.
- The instrumented candidate remains loaded from this worktree with `steerActiveThreadOnEnter` enabled. The steering bug remains unresolved. No regression tests were written or run for this refinement, and no commit or push was made.
- Before another live run, establish one bounded diagnostic channel that is readable from the provider process. Then repeat the same single diagnostic flow rather than changing ownership logic speculatively.

## Predicate refinement contract

The next authorized loop refines the existing `steerRestart` and `usableSteerLive` path. It does not add a second ownership state.

1. Add one temporary provider-process receipt containing only the post-replay ownership predicates already logged in memory. No prompt text is allowed.
2. Run one live steer and change code only if the receipt identifies one failed predicate.
3. Run one verification after that change. A third and final live run is allowed only when the second run identifies one narrower correction.
4. Stop immediately if a receipt is ambiguous, more than one ownership cause appears, a safe single-predicate change is unavailable, or the third live run fails.
5. Write regression tests only after the real steering flow passes. Coverage must protect a normal steer, real stop before replay, real stop immediately after replay, queue mode, ordinary completion, and abort-event ordering without asserting fixed idle-event or abort-call counts.

Success remains user-observable: the old tool stops within 3 seconds, one correction message and part persist, corrected output completes in the same BB turn before the old 20-second deadline, no old dinner output appears, and no post-replay self-abort occurs. Keep the successful candidate loaded for manual QA. Do not commit or push.

### Predicate diagnostic result

- Setup attempt `thr_gysx8k8w8w` did not enter the flow because OpenCode rejected the unsupported `gpt-5.4-mini` model. It does not count as a diagnostic iteration.
- Diagnostic run `thr_ti3q5npdgv`, session `ses_f4f3ae8d7ffem9No4r5daubjeT`, produced a provider-process receipt after replay: `same=false present=false liveBoundary=true liveStopping=false currentSession=-`.
- The live turn was settled and removed during the expected steer handoff. A genuine `thread/stop` did not cause the loss because the original live object never latched `stopping`.
- The first targeted refinement is limited to preventing `settleIssuedTurn` from closing a live turn while its existing `steerRestart` has not finished submitting replay. The real stop path remains authoritative and unchanged.

### Predicate refinement live result

`PASS` on the first targeted refinement in `thr_rf3aej2mwv`, session `ses_f4f351b22ffe69cueE6FX2Hc7q`.

- The correction persisted as one user message and one text part at `1789672487820`.
- The old `sleep 20` tool ended at `1789672487830`, 10 ms after correction persistence and about 3.9 seconds after it started.
- Post-replay ownership remained intact: `same=true present=true liveBoundary=false liveStopping=false`.
- Corrected output `CORRECTED_BREAKFAST_DONE` began at `1789672491057`, about 3.2 seconds after the correction and before the original 20-second deadline.
- The BB transcript contains no `OLD_DINNER_DONE` assistant output. The corrected response completed in the same BB turn.
- Remove the temporary provider-process file diagnostic before regression checks. Preserve the successful behavior with outcome-focused steering, real-stop, queue, ordinary-completion, and event-ordering coverage.

### User manual QA result

`PASS` for the focused steering flow in `thr_rf3aej2mwv`, using the final loaded candidate.

- User-visible receipt: `/Users/macvm/.bb/thread-storage/thr_65zc9458s4/Attachments/image-1789673289337-hwp1z1.png`.
- The original `sleep 20` tool started at `1789673249439`.
- The correction persisted once at `1789673251834`; the old tool ended at `1789673251845`, 11 ms later and about 2.4 seconds after starting.
- The corrected assistant step started at `1789673251906`; breakfast output began at `1789673254554`, about 2.7 seconds after the correction and well before the original 20-second deadline.
- The visible and persisted outputs contain `Breakfast plan ready.` and no dinner result.
- This proves the requested manual user flow. It does not clear the independent code-quality `REVISE_CODE` findings about other event orderings and failure races.

## Parent settlement-race refinement

The parent thread exposed a distinct false-accept race after the successful child flow. BB received a steer at `1789673279698`, emitted `turn/input/accepted` at `1789673279912`, and completed the old turn in the same millisecond. OpenCode stored no copy of that correction. The user's resend at `1789673290428` started a new turn and is the only persisted copy.

This refinement is intentionally narrower than a four-phase lifecycle rewrite:

1. Install the existing `steerRestart` settlement hold before the first steering `await`, without enabling abort-event suppression yet.
2. Make `settleIssuedTurn` honor that hold both at entry and after reading message history.
3. Persist the correction, then emit `input.accepted` only after persistence succeeds.
4. On persistence failure, clear the hold, restore the previous polling boundary, and explicitly settle if OpenCode is already idle.
5. Enable abort-event suppression only when an active runner will actually be aborted.

Prove behavior before changing tests. Use one fresh root BB parent and one child beneath it. Each runs a ten-second obsolete task and receives a live correction. Both corrected responses must complete without old output. Also preserve genuine Stop and persistence-failure behavior in focused checks after the live flows pass.

Stop this refinement if either parent or child live steering fails. Do not widen into the separate fixed-idle-counter redesign in the same pass. Do not commit or push.

### Parent and child live result

`PASS` in a fresh parent and its one authorized child on the exact loaded candidate.

- Parent `thr_sjtraeyy5z`, session `ses_f4f158499ffeOGojY9QOaNGK0L`: correction persisted once at `1789674554724`; `sleep 10` ended at `1789674554741`, 17 ms later; only `PARENT_STEERED` appeared.
- Child `thr_vcfnpcbbtp`, session `ses_f4f112502ffedHDl7hkILyRiPY`: correction persisted once at `1789674842036`; `sleep 10` ended at `1789674842049`, 13 ms later; only `CHILD_STEERED` appeared.
- Both corrected assistant runs completed normally. Neither old response appeared.
- The parent thread is `@thread:thr_sjtraeyy5z`; the child is `@thread:thr_vcfnpcbbtp`.

This proves the parent settlement-hold correction did not regress the previously working child steering flow. Regression tests may now preserve the observed behavior and failure recovery.

## Phase/fact reconciliation contract

- Do not add or run tests until fresh live parent, child, and genuine Stop flows pass.
- Make one implementation change, with at most one evidence-backed correction.
- Stop on any regression or ambiguous live evidence.

## Phase/fact regression freeze

Fresh live verification passed before adding regression coverage:

- Parent `thr_jiuvhqt6vu`, session `ses_f4ef50118ffe0mZNB6CU86hfNM`: same-turn correction produced only `PHASE_PARENT_STEERED`.
- Active-tool child `thr_keayvufn29`, session `ses_f4ee258c6ffeLlRSDzFU8s1u87`: `sleep 10` was interrupted, correction persisted once, and only `PHASE_CHILD_STEERED` appeared.
- Genuine Stop `thr_u4gwszjrd9`, session `ses_f4ee18425ffepK6ZYWAqn20aZe`: one `turn/completed status:interrupted`, with no old or corrected output.

Regression coverage now models corrected assistant history and checks zero, one, extra, and delayed old abort terminal event orderings without depending on a provider event count. It also covers completion observed before replay returns, genuine Stop during handoff, queue deferral, and no queue-mode persistence.

Targeted result: `npx vitest run tests/bridge.test.ts` — PASS, 1 file and 132 tests passed.

No production defect was exposed by this test pass; production changes remain the previously loaded candidate.
