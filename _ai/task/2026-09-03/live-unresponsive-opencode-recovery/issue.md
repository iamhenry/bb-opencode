# Live but unresponsive OpenCode server blocks BB thread startup without bounded recovery

- **Type:** `bug`
- **Source:** https://github.com/iamhenry/bb-opencode/issues/3
- **Intake date:** 2026-09-03

## Original GitHub Issue

A detached OpenCode server can remain alive and retain its lock while temporarily failing health and session RPCs. BB correctly refuses to launch a duplicate server, but thread startup then fails without a bounded recovery path or actionable, stage-specific diagnostics. Users must wait for spontaneous recovery or explicitly reload OpenCode, and naive retries can create duplicate replacement work after the original BB thread and worktree were provisioned.

The observed server later recovered without repository or configuration changes. The deeper reason it stopped answering is unknown and is not claimed by this issue.

The safe fix must preserve the live lock and active work, provide one bounded opportunity for transient recovery, distinguish health, attach, and session-creation failures, and return safe operator guidance for a persistent stall. Automatic recycling is acceptable only when the server is proven idle; otherwise recovery requires explicit operator action.

### Assumptions and missing product decisions

- Preserving a possibly active server and refusing a duplicate server remain mandatory safety behavior.
- Recovery and thread-start retry are bounded; timeout increases alone and indefinite retries are not acceptable.
- Deterministic mocked health and session behavior must reproduce the failure before implementation.
- The exact safe-recovery mechanism and the proof required to classify a server as idle remain research and proposal decisions.

## Acceptance Criteria

- A transient health or `session.create` timeout receives only a bounded recovery attempt; no unbounded retries occur.
- The plugin never spawns a second detached OpenCode server while a locked server may still be active.
- Persistent live-but-unresponsive state produces a structured error that distinguishes the failed stage and tells the operator how to recover safely.
- Automatic recycling, if implemented, occurs only when the server is proven idle; active sessions are never silently terminated.
- Thread startup is retried at most once after a successful safe recovery, without creating duplicate BB work.
- Diagnostic logs include stage, elapsed time, and recovery decision but exclude prompts, credentials, and private user content.
- Tests cover healthy attach, dead-server reclaim, transient slowness, and persistent live-but-unresponsive behavior.

## Gherkin Happy Path

### Happy Path: A transient stall recovers and the thread starts once

Given the locked OpenCode server is alive but temporarily unresponsive
When the user starts an OpenCode-backed BB thread and the bounded recovery succeeds
Then the thread starts once without a duplicate server or duplicate BB work

## Gherkin Edge Path

### Edge Path: A persistent stall fails safely with actionable diagnostics

Given the locked OpenCode server remains alive and unresponsive through the bounded recovery
When the user starts an OpenCode-backed BB thread
Then startup fails without terminating active work or spawning another server and identifies the failed stage and safe recovery action

## Current UX

### How a user starts an OpenCode-backed thread today

1. User picks **OpenCode** in BB and sends a message. BB issues `thread/start` over the provider bridge.
2. The bridge handler calls `ensureClient()` first (`src/bridge.ts:2400-2427`). If a cached client exists it is probed with `client.health()`; on failure the client is dropped and the bridge re-attaches from the lock file (`src/bridge.ts:388-418`).
3. Re-attach goes through `attachOrSpawn` (`src/bridge.ts:241`, `src/process.ts:281-296`): it reclaims the lock only if the port is proven dead, tries `attachIfHealthy`, and if a leftover lock remains it **throws instead of spawning a second server**.
4. On success the bridge creates/adopts an OpenCode session, binds it, and answers `providerThreadId` (`src/bridge.ts:2411-2427`); the first prompt then runs via `runPrompt` (`src/bridge.ts:2442-2456`).

### What the user sees in each failure stage

| Stage | What happens | What the user sees | Evidence |
|---|---|---|---|
| **Health probe timeout (transient)** | `probePort` uses an 800 ms `AbortSignal.timeout`; a timeout is classified `"slow"`, not `"dead"` — the lock is deliberately kept (`src/process.ts:151-181`). `attachIfHealthy` requires a full `"ok"` answer, so a slow server is not attachable (`src/process.ts:183-196`). | Startup fails with `OpenCode serve on :<port> did not answer in time. Not spawning another.` | `src/process.ts:291-296`; test asserts this exact message and that `spawn` is never called (`tests/process.test.ts:61-78`) |
| **Health RPC answered but unhealthy** | `client.health()` retries 3× at 800 ms each, then throws `OpenCode serve did not answer health (timed out)` (`src/client.ts:223-247`). `ensureClient` wraps any attach/health/version error through `publicErrorMessage`, which maps abort-timeouts to `OpenCode serve did not answer in time` (`src/bridge.ts:381-386, 409-411`). | The raw error string surfaces as the JSON-RPC error for `thread/start` (`src/bridge.ts:2457-2461`), which BB renders as the failed run. | `src/bridge.ts:2459-2461` |
| **Session creation fails after healthy attach** | `createSession` is bounded by `OPENCODE_SETUP_MS = 8_000` (`src/client.ts:145, 248-261`). | Error message like `session.create timed out after 8000ms` — **no stage label, no recovery guidance**; the message is passed through verbatim (`src/bridge.ts:2457-2461`). | `src/client.ts:150-169` |
| **Prompt fails mid-turn** | `runPrompt` catches and emits a `turn.boundary` delta with `status: "failed"` and the error message (`src/bridge.ts:3509-3519`, `failIssuedTurn` at `src/bridge.ts:491-512`). | BB shows the turn as failed with the message (e.g. `provider 503`); verified in tests (`tests/bridge.test.ts:3761-3806`). | `src/bridge.ts:505-511` |
| **Serve dies mid-turn** | `serveLost` fails all live turns and emits a `providerRecovery` notification with `kind: "restartRecommended"`, `retryable: true` (`src/bridge.ts:619-630`). | Turn fails; the recovery notification is consumed by BB host chrome, **not by any UI in this plugin** (no in-repo consumer found). | `src/bridge.ts:625-629` |

### What the user can do to recover today (manual only)

1. **Tools → OpenCode settings panel** (registered at `app.tsx:70-75`): shows Binary, Server version, Attach state (`attached`/`spawned`/`down`), Port, version range, serve cwd, plus `probe.error` and `probe.authError` lines (`src/app/settings-section.tsx:57-84`). The probe itself reports the leftover lock's port/pid and the failure message when attach fails (`src/probe.ts:136-152`).
2. **"Reload OpenCode" button**: calls the `reload` RPC → `handleReload` → `stopServe`, which SIGTERMs the locked process group, escalates to SIGKILL after ~3 s, and removes only the lock that serve still owns (`src/app/settings-section.tsx:86-99`, `src/host-handlers.ts:38-50`, `src/process.ts:106-129`). Result is shown inline: `Reloaded.` or the error (`src/app/settings-section.tsx:95-99`).
3. **CLI diagnostics**: `bb opencode status` (exit code 1 when `needsConfiguration`, prints binary/server/attach/port/pid/error/serveLog) and `bb opencode logs` (`server.ts:693-782`, `src/host-handlers.ts:52-56`).
4. **Startup badge**: at plugin start a background probe calls `bb.status.needsConfiguration(...)` with the probe error when configuration is needed (`server.ts:644-661`).

### Gaps in current UX (expected behavior with no surface)

- **No bounded automatic recovery.** A transient stall fails immediately on the first `thread/start`; there is no retry window. The only paths are wait for spontaneous recovery or manually Reload (`src/process.ts:291-296`; issue `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/issue.md:9`).
- **No stage distinction in user-facing errors.** Health-timeout, attach-refusal, and `session.create` timeout all surface as undifferentiated message strings; nothing labels the failed stage (`src/bridge.ts:2457-2461`).
- **No actionable guidance in the error.** The `did not answer in time` message never mentions the Reload button or `bb opencode status`; the user must discover recovery themselves.
- **`providerRecovery` / `restartRecommended` has no in-plugin consumer** — it is emitted only when the serve is fully lost (`src/bridge.ts:619-630`), never for the live-but-unresponsive case, and no UI in this repo renders it.
- **Provisioned state after failure is invisible in the thread.** If `createSession` succeeded before a later failure, an orphan OpenCode session exists and the BB thread/worktree remain, but the error surface does not tell the user the thread is safe to retry without duplicate work (issue.md:9, "naive retries can create duplicate replacement work").

## Post-change UX

Intended behavior per the issue's acceptance criteria and Gherkin paths (`_ai/task/2026-09-03/live-unresponsive-opencode-recovery/issue.md:22-46`). No UI for this exists yet — every item below is a flagged gap until implemented.

### Happy path — transient stall, bounded recovery succeeds

1. User starts an OpenCode-backed thread; the locked server is alive but temporarily unresponsive.
2. The plugin makes **one bounded recovery attempt** (no unbounded retries, no timeout-only increase — issue.md:24). The live lock is preserved throughout; no second server is ever spawned (issue.md:25; preserved invariant already enforced at `src/process.ts:291-296`).
3. Recovery succeeds → the thread starts **exactly once**, with no duplicate server and no duplicate BB work (issue.md:28, Happy Path at issue.md:32-38).
4. Diagnostic logs record stage, elapsed time, and the recovery decision — without prompts, credentials, or private content (issue.md:29). Natural home: the existing serve/debug log surfaces (`src/process.ts:36-49`, `src/bridge.ts:307-309`, surfaced via `bb opencode logs`, `server.ts:757-760`).

### Edge path — persistent stall

1. The locked server stays alive and unresponsive through the bounded recovery.
2. Startup fails **without terminating active work** and **without spawning another server** (issue.md:46, Edge Path at issue.md:40-46).
3. The error is **structured and stage-labeled** — it distinguishes health, attach, and session-creation failures (issue.md:26) — unlike today's pass-through strings (`src/bridge.ts:2457-2461`).
4. The error names the **safe operator action**: the existing Tools → OpenCode → Reload OpenCode path (`src/app/settings-section.tsx:86-99`), which is already the only proven-safe recycle because `stopServe` kills only the lock owner and preserves a replacement lock (`src/process.ts:105-129`, tested at `tests/process.test.ts:177-211`).
5. Automatic recycling, if added, happens **only when the server is proven idle**; active sessions are never silently terminated (issue.md:27). The existing idle-proof primitives (`/session/status` via `runningSessionIdsFromStatus`, `src/session-status.ts:44-63`; `sessionIsRunning`, `src/client.ts`) are the candidates for that proof — the exact proof standard is explicitly deferred to proposal research (issue.md:20).
6. Retry after successful recovery is **at most once**, preventing duplicate BB work (issue.md:28).

### UI surfaces needed post-change (currently missing)

- A stage-labeled, action-bearing error string for the persistent-stall case (replaces/augments `publicErrorMessage`, `src/bridge.ts:381-386`).
- A visible recovery-attempt indicator or warning during the bounded window (candidate: the existing `provider.warning` delta channel, `src/bridge.ts:519-547`).
- Persistent-failure guidance pointing at Tools → OpenCode (settings panel already shows attach state and probe error, `src/app/settings-section.tsx:57-84`) and `bb opencode status` (`server.ts:724-748`).

## Current Behavior

- `thread/start` calls `ensureClient`, creates one OpenCode session, binds it, emits one identity, and answers once before running the prompt (`src/bridge.ts:2389-2456`; [code archaeology](research/code-archaeology.md#3-the-startup-path-end-to-end)).
- A slow health response keeps the host-wide lock, fails strict attach, and reaches the existing no-spawn guard; this preserves the server but offers no recovery window (`src/process.ts:151-196,281-296`; [code archaeology](research/code-archaeology.md#33-attachorspawn--the-lockclaimspawn-state-machine-srcprocessts281-406)).
- Client health is bounded to three 800 ms attempts, while `session.create` gets one 8 second attempt; neither has a recovery decision between failure and the startup error (`src/client.ts:223-261`; [dependency map](research/dependency-map.md#3-data-flow-analysis--startup-threadstart-end-to-end)).
- Startup errors are message-only JSON-RPC failures, and timeout normalization erases health/attach stage detail (`src/bridge.ts:315-325,381-386,2457-2461`; [code archaeology](research/code-archaeology.md#37-startup-failure-surfacing)).
- Manual Reload calls `stopServe` without an idle proof; bridge-local active-turn state cannot prove that other BB workers are idle (`src/process.ts:105-129`; `src/host-handlers.ts:38-50`; [dependency map](research/dependency-map.md#8-risks-and-considerations)).

## Constraints

- Keep the host-wide live lock whenever the port is slow rather than proven dead, and never bypass the existing duplicate-spawn guard (`src/process.ts:51-59,170-196,291-296`; `tests/process.test.ts:61-78`).
- Bound every wait and recovery attempt; do not replace recovery with a longer timeout (`src/process.ts:16-17,317-322,357-366`; `src/client.ts:145,223-261`).
- Do not blindly replay `session.create`: the POST has no documented idempotency key, and a timeout is ambiguous ([external signal](research/external-signal.md#3-post-session-has-no-idempotency-mechanism--a-blind-retry-after-an-ambiguous-timeout-can-create-duplicate-sessions)).
- Retry only before the one `respondResult`; do not re-enter the whole handler or duplicate session binding, identity notifications, responses, or BB work (`src/bridge.ts:2410-2427`; [dependency map](research/dependency-map.md#6-invocation-order-and-cardinality-summary-startup-happy-path)).
- Do not automatically stop or reload unless all active work can be proven idle across the host. An unknown or unreachable status is not idle (`src/session-status.ts:37-60`; [dependency map](research/dependency-map.md#8-risks-and-considerations)).
- Log only stage, elapsed time, bounded recovery decision, and sanitized status/error classes; never prompts, credentials, raw environment, paths, or private user content ([external signal](research/external-signal.md#6-owasp-logging-cheat-sheet-log-event-level-facts-never-sensitive-data-and-sanitize-event-content-against-log-injection)).

## Style Rules

- Keep startup concerns in the existing flat modules; prefer a small colocated helper over a new layer (`src/process.ts`, `src/client.ts`, `src/bridge.ts`; [style fingerprint](research/style-fingerprint.md#module-organization)).
- Follow TypeScript ESM conventions, existing naming, `_MS` duration constants, two-space indentation, double quotes, and trailing commas ([style fingerprint](research/style-fingerprint.md#naming)).
- Reuse `isAbortTimeout`, `publicErrorMessage`, `ProbeResult`, existing ring-buffer logs, and the `ok | slow | dead` probe semantics rather than creating parallel mechanisms (`src/process.ts:140-181`; `src/bridge.ts:381-386`; `src/probe.ts:16-31`).
- Use fixed-count loops and existing timeout primitives; inject time through `deps.now` where deterministic elapsed-time assertions need it (`src/process.ts:317-366`; `src/bridge.ts:145,458-461`).
- Extend the existing hand-written fake and adjacent Vitest files, with negative assertions for no spawn/kill/duplicate calls (`tests/fake-opencode.ts:3-49,95-160`; `tests/process.test.ts:61-78`; `tests/bridge.test.ts:57-72`).

## Blast Radius

- The narrow runtime path is `ensureClient` and pre-answer `thread/start` in `src/bridge.ts`, `attachOrSpawn` lock behavior in `src/process.ts`, health/session timeouts in `src/client.ts`, and their tests ([dependency map](research/dependency-map.md#3-data-flow-analysis--startup-threadstart-end-to-end)).
- Changing `attachOrSpawn` behavior affects 12 call sites: the bridge, 11 host-handler uses, and startup probing; process-layer waits could delay unrelated settings and host operations (`src/bridge.ts:241`; `src/host-handlers.ts:64-274`; `src/probe.ts:81-85`; [dependency map](research/dependency-map.md#41-attachorspawn-srcprocessts281-406--every-caller)).
- Changing public error strings can break process tests and probe/settings output; adding structured data must retain a compatible actionable message (`tests/process.test.ts:61-78`; `contract.ts:23-40`; `src/app/settings-section.tsx:57-84`).
- The highest-risk regressions are a second detached server, a duplicate OpenCode session or identity/result, a double response, or termination of active work (`src/process.ts:291-296`; `src/bridge.ts:755-775,2410-2427`; [dependency map](research/dependency-map.md#8-risks-and-considerations)).

## External Signal

- Official OpenCode APIs make `global.health` the read-only liveness probe and `session.status` the source for `idle | busy | retry`; health alone does not prove idle ([OpenCode server docs](https://opencode.ai/docs/server/); [external signal](research/external-signal.md#findings)).
- `POST /session` has no documented idempotency mechanism, so recovery must probe and reconcile rather than blindly repeat session creation ([OpenCode server docs](https://opencode.ai/docs/server/); [external signal](research/external-signal.md#3-post-session-has-no-idempotency-mechanism--a-blind-retry-after-an-ambiguous-timeout-can-create-duplicate-sessions)).
- Recovery must use a client attached to the locked server, not the SDK server-start helper, whose timeout path terminates its spawned process ([OpenCode SDK docs](https://opencode.ai/docs/sdk/); [external signal](research/external-signal.md#4-the-sdks-own-server-start-path-kills-the-spawned-process-on-timeout--do-not-use-createopencodecreateopencodeserver-for-recovery-against-the-locked-server-use-createopencodeclient-client-only-never-spawns)).
- Node 22 supports bounded `AbortSignal.timeout` and cancellation composition with `AbortSignal.any`; the abort reason can distinguish timeout from cancellation ([Node.js globals](https://nodejs.org/docs/latest-v22.x/api/globals.html); [external signal](research/external-signal.md#5-abortsignaltimeoutdelay-is-the-supported-per-attempt-bound-node-1731614-repo-targets-node-22-abortsignalanysignals-composes-it-with-a-cancellation-signal-and-the-abort-reason-distinguishes-timeout-from-external-cancellation-for-stage-diagnostics)).
- OWASP recommends event-level operational facts while excluding and sanitizing sensitive content, matching stage/elapsed/decision-only diagnostics ([OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html); [external signal](research/external-signal.md#6-owasp-logging-cheat-sheet-log-event-level-facts-never-sensitive-data-and-sanitize-event-content-against-log-injection)).

## Research Index

- [Code Archaeology](research/code-archaeology.md)
- [Dependency Map](research/dependency-map.md)
- [UX Behavior](research/ux-behavior.md)
- [Style Fingerprint](research/style-fingerprint.md)
- [External Signal](research/external-signal.md)

## Approaches

The ranking prioritizes the smallest safe diff, existing style, reversibility, and preservation of active work. All options reject timeout-only changes, blind session-create replay, duplicate servers, and automatic recycle without host-wide idle proof.

### 1. Bridge-local bounded recovery and read-only session reconciliation — recommended

- **Shape:** Keep `attachOrSpawn` and its lock/no-spawn behavior unchanged. In `ensureClient` and the pre-answer portion of `thread/start`, classify `health`, `attach`, and `session-create`; make one bounded health/attach recovery attempt against the locked URL; and record stage, elapsed time, and decision in the existing debug log (`src/bridge.ts:388-418,2389-2427`; `src/process.ts:291-296`). After an ambiguous `session.create` timeout, use bounded read-only session list/status reconciliation and continue only when the original created session is uniquely provable; otherwise stop with actionable operator guidance and never issue a second POST ([external signal](research/external-signal.md#3-post-session-has-no-idempotency-mechanism--a-blind-retry-after-an-ambiguous-timeout-can-create-duplicate-sessions)).
- **Why ranked first:** It reuses the bridge choke point and existing probes, leaves 11 host-handler call sites unchanged, introduces no automatic process termination, and keeps the mutation count at one ([dependency map](research/dependency-map.md#9-recommended-approach-evidence-based-design-neutral)).
- **Tradeoffs:** Lowest blast radius and easiest rollback, but host RPCs retain their current fast-fail diagnostics. Reconciliation must fail closed when session identity is ambiguous, so some transient `session.create` timeouts still require operator action rather than unsafe replay.
- **Regression probe:** With deterministic slow-then-healthy health and ambiguous session-create mocks, assert the recovery budget is attempted no more than once, `createSession`, `bindSession`, `thread/identity`, and `respondResult` each occur at most once, `spawn` and `stopServe` are never called, and the original lock remains unchanged (`tests/process.test.ts:61-78`; `tests/bridge.test.ts:573-591,861-884`).
- **Maintainer check:** Would a maintainer approve this PR without asking for changes? **Likely yes**: it is the smallest design that meets the safety invariants without spreading waits or adding speculative infrastructure.

### 2. Shared typed startup failure with a bounded bridge recovery coordinator

- **Shape:** Add one narrow startup-failure value carrying `stage`, `elapsedMs`, `recoveryDecision`, and `operatorAction`; have existing process/client boundaries preserve it through `publicErrorMessage`, while a bridge-local coordinator owns the single bounded recovery attempt and the same fail-closed session reconciliation (`src/process.ts:140-196,281-296`; `src/client.ts:223-261`; `src/bridge.ts:315-325,381-418`). Preserve the existing message text for compatibility and expose structured fields only where the bridge contract supports them.
- **Why ranked second:** It gives health, attach, and session-create one consistent source of truth and improves future diagnostics across callers, but changes more module boundaries than the bug strictly requires.
- **Tradeoffs:** Clearer stage semantics and easier focused tests versus a larger diff, error-contract compatibility work, and a risk of turning one bug fix into a general error framework. Recovery remains bridge-only so host handlers do not inherit extra latency.
- **Regression probe:** Drive each typed failure stage independently and assert exactly one terminal response, no second `session.create` or identity notification, no detached `spawn` or `stopServe`, no lock replacement, and stable legacy message text for existing process/probe tests (`tests/process.test.ts:61-78`; `contract.ts:23-40`; `src/bridge.ts:2410-2427`).
- **Maintainer check:** Would a maintainer approve this PR without asking for changes? **Maybe**: the shared type is defensible only if the judge values consistent structured diagnostics enough to justify touching three runtime modules.

### 3. Bounded recovery plus an operator-mediated idle-aware recovery surface

- **Shape:** Implement the bounded, stage-specific bridge recovery from Approach 1, then extend the existing settings/host path to query `session.status` before offering recovery. Automatically recycle only when status conclusively shows all host-wide work idle; when status is busy, retrying, unreachable, or ambiguous, do not kill or reload and instead present an explicit operator action with interruption risk and `bb opencode status` guidance (`src/session-status.ts:37-60`; `src/host-handlers.ts:38-92`; `src/app/settings-section.tsx:40-99`).
- **Why ranked third:** It offers the strongest guided UX but expands into host contracts and UI even though a stage-specific startup error may be sufficient. It is least reversible and carries the widest safety surface.
- **Tradeoffs:** Better discoverability and an explicit path out of a persistent stall versus more files, UI/contract work, and an unavoidable fail-closed result when an unresponsive server cannot prove idle. Explicit operator confirmation remains necessary whenever global idle cannot be proven.
- **Regression probe:** Simulate idle, busy, retrying, unreachable, and replacement-lock races; assert automatic `stopServe` is called only for conclusively all-idle status, never for unknown/active status, never spawns a duplicate server, preserves a racing replacement lock, and never duplicates session creation, identity, response, or BB work (`tests/process.test.ts:177-211`; `src/process.ts:86-129`; [dependency map](research/dependency-map.md#8-risks-and-considerations)).
- **Maintainer check:** Would a maintainer approve this PR without asking for changes? **Unlikely as the first fix**: it is safe only with strict fail-closed idle proof and adds UI scope beyond the smallest recovery contract.

## Judge Decision

Status: SELECTED
Selected Approach: Bridge-local bounded recovery and read-only session reconciliation
Confidence: High

Scores:
- Bridge-local bounded recovery and read-only session reconciliation: 95/100 - Meets every safety boundary at the existing bridge choke point, reuses lock/probe behavior, and has clear once-only regression checks with the smallest blast radius.
- Shared typed startup failure with a bounded bridge recovery coordinator: 85/100 - Meets the behavior and improves diagnostic consistency, but spreads one startup fix across three runtime modules and creates avoidable compatibility work.
- Bounded recovery plus an operator-mediated idle-aware recovery surface: Rejected - Fails the added-scope hard gate by introducing host-contract, process-recycling, and UI work not required for safe startup recovery.

Decision:
- Approach 1 preserves the tested no-spawn lock guard while placing bounded recovery at `ensureClient`, the existing bridge choke point, so 11 host-handler callers retain fast-fail behavior ([dependency map](research/dependency-map.md#9-recommended-approach-evidence-based-design-neutral)).
- Its stage classification and existing key-value debug log cover health, attach, and session-create diagnostics without logging private content; the required fields and privacy boundary are explicit in the acceptance criteria (`issue.md:26-29`) and external evidence ([external signal](research/external-signal.md#6-owasp-logging-cheat-sheet-log-event-level-facts-never-sensitive-data-and-sanitize-event-content-against-log-injection)).
- Read-only reconciliation after an ambiguous `session.create` timeout fails closed unless the original session is uniquely provable, avoiding the undocumented-idempotency duplicate-work hazard ([external signal](research/external-signal.md#3-post-session-has-no-idempotency-mechanism--a-blind-retry-after-an-ambiguous-timeout-can-create-duplicate-sessions)); its probe also asserts once-only create, bind, identity, and response behavior (`issue.md:165`).
- Approach 2 is viable but loses on least scope and blast radius; Approach 3 adds automatic process/UI recovery despite global idleness being unprovable from bridge-local state ([dependency map](research/dependency-map.md#8-risks-and-considerations)).

Question:
N/A
