# Plan: Bridge-local bounded recovery for an unresponsive OpenCode server

## Goal

Allow an OpenCode-backed `thread/start` to survive one transient health or attach stall, and safely reconcile one ambiguous `session.create` timeout, while preserving the live server lock, active work, and every once-only thread-start side effect. Persistent stalls must fail closed with stage-specific, privacy-safe diagnostics and explicit operator guidance.

## Acceptance Criteria

- [ ] A deterministic pre-fix bridge test reproduces a transient live-but-unresponsive attach/health failure and fails because startup currently has no bounded recovery opportunity.
- [ ] `ensureClient` performs no more than one additional bridge-local health/attach attempt for a recovery-eligible stall; existing per-call timeout values remain unchanged and no unbounded loop or timeout increase is introduced.
- [ ] `attachOrSpawn` and its live-lock/no-spawn behavior remain unchanged; existing slow-health and dead-server reclaim tests pass, and no automatic `spawn`, `stopServe`, reload, kill, or lock removal path is added.
- [ ] A healthy initial attach starts the thread normally without entering recovery.
- [ ] A transient attach or health stall followed by recovery creates, binds, identifies, answers, and prompts the thread exactly once.
- [ ] A persistent failure is classified as exactly `health`, `attach`, or `session-create` and produces one JSON-RPC error before any successful response.
- [ ] An ambiguous `session.create` timeout causes exactly one bounded, read-only `listSessions` reconciliation and never causes a second `session.create` POST.
- [ ] Reconciliation continues only when exactly one session carries the request's opaque correlation title and expected directory; zero or multiple matches fail closed before binding, identity notification, response, or prompt execution.
- [ ] Recovery diagnostics use privacy-safe key-value fields containing only `stage`, elapsed milliseconds, bounded decision, and safe operator action; tests prove they exclude prompt text, credentials, requested paths/directories, correlation tokens, and raw server errors/output.
- [ ] Persistent-stall guidance tells the operator to inspect `bb opencode status` and to use **Tools → OpenCode → Reload OpenCode** only after confirming active work is safe to interrupt.
- [ ] Existing `session.create` no-id behavior, healthy startup, Task create-count, process lock, targeted bridge/process tests, full tests, typecheck, and build all pass.
- [ ] A screenshot is saved at `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/evidence/recovery-targeted-tests.png`, showing the deterministic targeted test command passing and visible test names for bounded recovery, fail-closed session reconciliation, stage-specific error guidance, and the no-duplicate-spawn invariant.

## User Story

As a BB user starting an OpenCode-backed thread, I want one safe bounded recovery opportunity when the existing detached server is temporarily unresponsive, so a transient stall can recover without duplicating work and a persistent stall tells me how to investigate and recover without silently interrupting active sessions.

## BDD Scenarios

### Happy Path

```gherkin
Scenario: A transient stall recovers and the thread starts once
  Given the locked OpenCode server is alive but temporarily unresponsive
  When the user starts an OpenCode-backed BB thread and the bounded recovery succeeds
  Then the thread starts once without a duplicate server or duplicate BB work
```

### Edge Path

```gherkin
Scenario: A persistent stall fails safely with actionable diagnostics
  Given the locked OpenCode server remains alive and unresponsive through the bounded recovery
  When the user starts an OpenCode-backed BB thread
  Then startup fails without terminating active work or spawning another server and identifies the failed stage and safe recovery action
```

## Scope and Boundaries

### In Scope

- Bridge-local recovery and stage classification in `src/bridge.ts`, centered on `ensureClient` and the pre-answer `thread/start` session-creation block.
- Reuse of existing client health, attach, session list, debug-log, elapsed-clock, and timeout mechanisms.
- A bounded `listSessions` client call using the existing setup timeout so session reconciliation itself cannot hang.
- Deterministic fake/test seams and focused regression cases in `tests/fake-opencode.ts` and `tests/bridge.test.ts` only where they reduce repeated inline stubs.
- Regression execution of existing `tests/process.test.ts` to prove slow locks remain preserved and duplicate spawn remains forbidden.
- Non-UI verification plus one terminal screenshot suitable for later PR attachment.

### Out of Scope / Must Not Change

- `src/process.ts`, especially `attachOrSpawn`, `reclaimIfStale`, `attachIfHealthy`, lock ownership, and the live-lock/no-spawn invariant.
- Automatic kill, reload, recycle, process replacement, duplicate server startup, or any inference that an unreachable server is idle.
- Host RPC contracts, settings UI, provider-recovery UI, or changes to `server.ts`, `host.ts`, `contract.ts`, `src/host-handlers.ts`, and `src/app/`.
- Retrying the complete `thread/start` handler or replaying `respondResult`, `bindSession`, `thread/identity`, prompt execution, or BB provisioning.
- Increasing `OPENCODE_SETUP_MS`, health timeouts, process probe timeouts, or retry counts in the process layer.
- Blindly retrying `session.create`; there must be exactly one POST.
- Logging prompts, credentials, directories/paths, private content, correlation titles, exception messages, or raw OpenCode output.
- Reproducing against, stopping, restarting, or otherwise touching the live detached OpenCode server.
- GitHub #2, shared/sibling worktrees, PR creation, merge, or unrelated cleanup.

## Codebase Orientation

| Area | Location | Implementation relevance |
|---|---|---|
| Public startup error and client acquisition | `src/bridge.ts:381-418` | `publicErrorMessage` currently erases timeout stage detail; `ensureClient` is the bridge choke point and already drops a failed cached client before reattaching. |
| Pre-answer startup lifecycle | `src/bridge.ts:2389-2427` | Recovery must finish before the single bind, identity notification, `session.reset`, and `respondResult`; never wrap the full handler. |
| Bridge test dependencies and clock | `src/bridge.ts:145-150,239-297` | `BridgeDeps.attach`, `acquire`, `write`, and `now` provide deterministic recovery, call-count, elapsed-time, and message assertions. |
| Setup timeout and client operations | `src/client.ts:145-169,223-279` | Keep existing timeout values; health is already bounded, `createSession` is one bounded POST, and `listSessions` needs the same bounded setup wrapper for reconciliation. |
| Process lock safety | `src/process.ts:140-196,281-302` | Slow means alive, the lock remains, and a leftover lock blocks duplicate spawn. This code is a regression boundary, not an edit target. |
| Diagnostics sink | `src/debug-log.ts:1-15`, `src/bridge.ts:307-309` | Reuse the existing ring buffer and compact key-value style; inspect only newly prefixed recovery lines in privacy tests. |
| Bridge test harness | `tests/bridge.test.ts:25-72,573-591,861-884` | Existing `send`, `flush`, injected dependencies, no-id error, and once-only create assertions are the nearest precedents. |
| OpenCode fake | `tests/fake-opencode.ts:3-49,51-160` | Extend only the call counters/overridable health-create-list seams required for deterministic ordered failures and reconciliation. |
| Process regressions | `tests/process.test.ts:61-95` | Existing tests prove slow locks are retained, no duplicate serve is spawned, and dead locks are reclaimed. |

## Dependencies

- **Runtime:** Existing `@opencode-ai/sdk` `1.18.21`, Node 22 APIs, `OpenCodeClient`, `attachOrSpawn`, `isAbortTimeout`, and `debugLog`; add no package.
- **Standard library:** Use `node:crypto` `randomUUID()` only if needed to generate a request-local opaque correlation title; do not build a custom ID generator.
- **Test:** Existing Vitest setup, bridge dependency injection, hand-written OpenCode fake, and process `spawn` mock.
- **Behavioral dependency:** OpenCode session list returns the title and directory sent to `session.create`. If a deterministic contract test disproves exact round-tripping, reconciliation must remain fail-closed and the implementation must stop for a revised proof mechanism rather than weaken uniqueness.
- **Operational dependency:** `bb opencode status` and **Tools → OpenCode → Reload OpenCode** already exist; this patch only references them in guidance and does not call them.

## Data Flow

1. `thread/start` enters the existing pre-answer path and records the injected start time.
2. `ensureClient` performs the normal cached health check or attach/acquire/health sequence.
3. On a recovery-eligible health or attach stall only, the bridge records a privacy-safe `decision=recover` diagnostic and performs one additional attach/acquire/health sequence. Non-stall errors such as version skew remain immediate failures.
4. If the additional attempt succeeds, the bridge records `decision=recovered` and returns one active client. If it fails, the bridge records `decision=fail-closed` and throws one stage-labeled actionable error.
5. For a new session, `thread/start` creates one request-local opaque correlation title, calls `createSession` exactly once with that title and the existing directory, and does not re-enter this mutation.
6. If creation returns, the returned ID follows the existing path. If and only if creation has an ambiguous timeout, the bridge records `stage=session-create decision=reconcile` and calls bounded `listSessions` once.
7. Reconciliation selects sessions whose title exactly equals the opaque correlation title and whose directory exactly equals the requested directory. Exactly one match proves the original request's session; zero or multiple matches produce `decision=fail-closed`. The title/token is never logged or included in an error.
8. A returned or uniquely reconciled ID enters the existing once-only sequence: validate ID → bind session → emit one identity → emit reset → answer once → run the prompt at most once.
9. Any persistent pre-answer failure returns one JSON-RPC error with a stage, elapsed time, decision, `bb opencode status`, and conditional safe-reload guidance. No process action is taken.

## Model and Architecture Notes

- Keep all recovery coordination private to `src/bridge.ts`; do not add a general recovery framework or exported cross-layer error hierarchy.
- Use a narrow local stage union: `"health" | "attach" | "session-create"`. Stage is assigned by the operation boundary, not inferred from raw server output.
- Treat only known timeout/live-lock messages as recovery-eligible. Do not retry configuration, binary, authentication, validation, or version-window failures.
- One recovery opportunity means at most two total attempts for the failed read-only health/attach boundary: the normal attempt plus one additional attempt. Existing retries internal to `client.health()` remain unchanged.
- `session.create` has different semantics from health/attach: it is called once. Its only recovery path is one bounded read-only reconciliation, never another POST.
- Use an opaque UUID-backed correlation title because the installed API exposes no idempotency key. Exact title plus exact directory and exactly one match is the proof threshold; ambiguity is a hard failure.
- Do not expose the correlation title in diagnostics. Normal OpenCode title generation may replace it after the first prompt; document and test the brief placeholder-title tradeoff rather than adding a cleanup mutation that creates another failure mode.
- Keep diagnostics as fixed literals, for example `startup-recovery stage=attach elapsed_ms=120 decision=recovered action=none`. Never interpolate caught errors, URLs, ports, paths, session IDs, titles, or user input.
- Preserve `respondResult`'s current position and the `answered` guard. Recovery applies only before the first successful response.

## Deliverables

- Updated `src/bridge.ts` with one bridge-local bounded recovery opportunity, stage-specific actionable errors, privacy-safe diagnostics, and fail-closed session reconciliation.
- Updated `src/client.ts` with bounded `listSessions` using the existing setup timeout and no timeout-value changes.
- Minimal deterministic fake additions in `tests/fake-opencode.ts` if the tests cannot express ordered health/create/list behavior cleanly through direct method overrides.
- Focused reproduction and regression coverage in `tests/bridge.test.ts`; no process implementation changes.
- Passing targeted tests, full test suite, typecheck, and build.
- Screenshot evidence at `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/evidence/recovery-targeted-tests.png` containing no private paths, prompts, credentials, server output, or live-server interaction.

## Error Handling

- Preserve existing messages for unrelated failures such as invalid parameters, missing session IDs, and version mismatch.
- Convert terminal startup stalls into a stable message shape whose public fields are limited to stage, elapsed time, bounded decision, and safe operator action.
- Use the exact stage values `health`, `attach`, and `session-create` in logs and user-visible errors.
- For persistent stalls, include: `Inspect bb opencode status. Use Tools → OpenCode → Reload OpenCode only after confirming active work is safe to interrupt.`
- If health/attach recovery fails, clear the tentative cached client as today and fail before session mutation.
- If session creation times out, do not assume failure and do not issue another POST. Attempt one bounded list; continue only on one exact correlation match.
- If list reconciliation times out, errors, yields zero matches, yields multiple matches, or returns a match without an ID, fail closed before binding or response.
- Do not append the caught exception, raw response, URL, port, directory, prompt, credential, or correlation marker to logs or the public error.

## Implementation Checklist

### Phase 1 — Deterministic reproduction before implementation

- [ ] **TEST — `tests/bridge.test.ts` near the existing `thread/start` failure cases:** Add a slow/failing-first attach or health case that expects one bounded recovery and eventual single startup; assert it fails against the current implementation before editing runtime code.
- [ ] **TEST — `tests/bridge.test.ts`:** Add the persistent health/attach case expecting exactly one additional attempt, a stage-specific actionable error, no create/bind identity/result/prompt, and privacy-safe diagnostics.
- [ ] **RUN — repository root:** Run `npx vitest run --config vitest.config.ts tests/bridge.test.ts -t "bounded startup recovery"` and record the expected pre-fix failure in the implementation handoff; do not run the live server.

### Phase 2 — Health and attach recovery

- [ ] **IMPLEMENT — `src/bridge.ts` beside `publicErrorMessage` and `ensureClient`:** Add the smallest private helpers/types for fixed stage values, recovery-eligibility classification, elapsed time via `deps.now?.() ?? Date.now()`, privacy-safe key-value logging, and the actionable terminal message.
- [ ] **IMPLEMENT — `src/bridge.ts:388-418`:** Refactor only the attach/acquire/health sequence so a recovery-eligible health or attach stall receives one additional attempt; retain cached-client invalidation, version checks, resubscription, and all existing non-stall behavior.
- [ ] **TEST — `tests/bridge.test.ts`:** Cover healthy first attempt, attach slow-then-healthy, health fail-then-healthy, persistent attach, and persistent health. Assert exact attempt ceilings and fixed stage/elapsed/decision/action fields.

### Phase 3 — Once-only session-create reconciliation

- [ ] **IMPLEMENT — `src/client.ts:277-279`:** Wrap `sdk.session.list()` with existing `withTimeout(..., OPENCODE_SETUP_MS, "session.list")`; do not add or increase a timeout constant.
- [ ] **IMPLEMENT — `src/bridge.ts:2404-2416`:** Generate one opaque correlation title before the sole `createSession` call; on its recognized timeout only, perform one bounded `listSessions` call and accept exactly one exact title-and-directory match.
- [ ] **IMPLEMENT — `src/bridge.ts:2414-2427`:** Ensure create accounting reflects one attempted POST and route a returned or reconciled session ID through the existing bind/identity/reset/result/prompt sequence without replaying any step.
- [ ] **TEST — `tests/fake-opencode.ts`:** Add only the smallest call counters or overridable `health`, `createSession`, and `listSessions` hooks needed to model a create side effect followed by a timeout and ordered recovery responses.
- [ ] **TEST — `tests/bridge.test.ts`:** Add uniquely reconciled, zero-match, multiple-match, and reconciliation-error cases. Assert one create call, no second POST, at most one list call, and at most one bind identity, result, and prompt.

### Phase 4 — Safety, privacy, and regressions

- [ ] **TEST — `tests/bridge.test.ts`:** Inject sentinel prompt, credential, directory, correlation, and raw-error strings; assert newly added recovery log lines and public errors contain none of them while retaining the required fixed fields and operator guidance.
- [ ] **TEST — `tests/bridge.test.ts`:** Re-run the existing no-session-ID and create-count cases to ensure unrelated once-only behavior remains intact.
- [ ] **VERIFY — repository root:** Run `npx vitest run --config vitest.config.ts tests/bridge.test.ts tests/process.test.ts` and confirm the slow-lock no-spawn and dead-lock reclaim tests still pass without modifying `src/process.ts`.
- [ ] **VERIFY — repository root:** Run `npm test`, `npm run typecheck`, and `npm run build`.
- [ ] **REVIEW — changed files:** Confirm no timeout value increased, no loop is unbounded, no second `session.create` path exists, and no host/UI/process-recycling file changed.

### Phase 5 — Observable proof

- [ ] **CAPTURE — terminal only:** Re-run a deterministic targeted command with concise output that visibly includes the passing bounded-recovery, reconciliation fail-closed, stage-guidance, and process no-spawn test names; do not start or probe the live detached server.
- [ ] **CAPTURE — `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/evidence/recovery-targeted-tests.png`:** Save a screenshot of that passing terminal result, cropped to exclude usernames, absolute paths, environment values, prompts, credentials, and unrelated terminal history.
- [ ] **VERIFY — evidence:** Confirm the screenshot is readable and the command/result proves mocked behavior only; reference this path in the later PR body.

## Risks and Blockers

| Risk / blocker | Mitigation / stop condition |
|---|---|
| A blind second POST could create an orphan or duplicate OpenCode session. | Keep `session.create` structurally single-call and test its call count in every timeout branch. |
| Concurrent session creation could make list-based recovery ambiguous. | Require one exact opaque-title plus directory match; zero or multiple matches fail closed. Do not weaken this threshold. |
| OpenCode may not round-trip a supplied title exactly in `listSessions`. | Prove the behavior with deterministic client tests and, during implementation research only, installed SDK types/source. If exact matching is unsupported, stop and return a blocker rather than infer identity. |
| The correlation title may be briefly visible before normal title generation. | Keep it opaque and non-sensitive; do not add cleanup mutation. Escalate if product review rejects the temporary placeholder because no equally strong idempotency primitive is documented. |
| Recovery added to `attachOrSpawn` would delay 11 host callers or weaken lock safety. | Do not edit `src/process.ts`; keep coordination in `ensureClient` and verify the existing process tests unchanged. |
| Retrying the handler could duplicate binding, identity, response, or prompt work. | Retry only the specific pre-answer health/attach operation; route one session ID into the original linear once-only tail. |
| Diagnostics could leak paths or private server content. | Log fixed literals only and add sentinel negative assertions against recovery logs and public errors. |
| Real timing tests could be slow or flaky. | Use injected `deps.now`, immediate ordered fake failures, and call counts; do not wait for real 8-second timeouts in unit tests. |
| Live-server verification could interrupt active work. | Verification is mocked/non-UI only; never execute, reload, kill, or probe the detached server for this patch. |

## Complexity and Estimate

- **Complexity:** Medium. The runtime diff is narrow, but ambiguous POST reconciliation and once-only ordering are safety-sensitive.
- **Estimate:** 5–8 engineering hours: 1–2 hours for failing deterministic tests, 2–3 hours for bridge/client implementation, 1–2 hours for safety/privacy regressions, and about 1 hour for full verification and screenshot evidence.

## Verification Gate Plan

**Verification Mode:** Non-UI deterministic mocked verification, plus a terminal screenshot; no live OpenCode server interaction.

**Objective:** Prove that one transient startup stall recovers, persistent stalls fail closed with safe stage-specific guidance, an ambiguous session creation is never replayed, and existing lock/no-spawn behavior remains intact.

**Primary Flow:** Run the targeted bridge cases for healthy startup, attach/health slow-then-healthy recovery, and uniquely reconciled session creation; verify exactly one create, bind identity, result, and prompt with one bounded recovery opportunity.

**Regression Check:** Run `npx vitest run --config vitest.config.ts tests/bridge.test.ts tests/process.test.ts`, then `npm test`, `npm run typecheck`, and `npm run build`; verify existing slow-lock/no-spawn, dead-lock reclaim, session-create no-id, and Task create-count coverage remains green.

**Evidence Plan:** Save `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/evidence/recovery-targeted-tests.png` showing the deterministic targeted test command and passing test names for bounded recovery, fail-closed reconciliation, stage-specific guidance, and no duplicate spawn. Crop all private shell context and include no live-server output.

**Pass Criteria:** Every acceptance checkbox is satisfied; targeted and full commands exit zero; each recovery branch obeys its call ceiling; diagnostics contain only allowed fields; `src/process.ts`, host/UI contracts, and process recycling remain unchanged; and the screenshot clearly proves the mocked user-visible failure/success assertions.

**Blocked Conditions:** Exact session identity cannot be proven from an opaque create correlation title and bounded list response; the SDK/server does not preserve the correlation value; deterministic tests cannot distinguish the three required stages without broad contract changes; verification would require touching the live detached server; or unrelated baseline test/build failures prevent attributing results to this patch. Any blocker returns to the next pipeline owner without implementing a weaker retry or automatic recycle.

## Plan Judge

- Decision: `APPROVE_PLAN`
- Score: 98
- Chosen proposal: Bridge-local bounded recovery and read-only session reconciliation, preserving `attachOrSpawn`, the live lock, and once-only startup side effects.
- Checked: issue.md, plan.md, research/code-archaeology.md, research/dependency-map.md, research/ux-behavior.md, research/style-fingerprint.md, research/external-signal.md; ETHOS and create-issue references were absent, so the judge-plan embedded principles and required structure were used.

### Notes

- The plan is faithful to the selected proposal: recovery remains bridge-local and bounded, session creation is never replayed, reconciliation binds only one exact correlation-title-and-directory match, and ambiguity fails closed.
- The phased checklist names concrete files and commands, requires deterministic reproduction before runtime edits, covers exact once-only behavior and privacy-safe diagnostics, and defines executable mocked verification with screenshot evidence.

### Required Changes

- None
