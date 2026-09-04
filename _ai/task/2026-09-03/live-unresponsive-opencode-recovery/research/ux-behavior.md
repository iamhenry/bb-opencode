# UX Behavior Report — Live-but-Unresponsive OpenCode Server (Issue #3)

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