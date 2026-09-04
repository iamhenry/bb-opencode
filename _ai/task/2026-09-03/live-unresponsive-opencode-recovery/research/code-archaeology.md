# Code Archaeology: Detached-Server Attach/Spawn, Health, Session Creation, Thread Binding, and Startup Failure (GitHub #3)

**Target:** `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/research/code-archaeology.md`
**Scope:** `bb-plugin-opencode` worktree at commit `20e20ca`. Read-only. Every claim is cited; unverified items are listed in Open Questions.

---

## 1. Executive Summary

The plugin attaches to a single host-wide detached OpenCode serve via a lock file (`~/.bb/plugins/opencode/opencode.lock.json`). The issue #3 failure path is already partially fenced: a slow-but-alive serve keeps its lock and the plugin refuses to spawn a duplicate (`tests/process.test.ts:61-78`). However, when the locked serve is alive but not answering **within the strict 800 ms health probe**, startup fails immediately with a flat string error — there is no bounded recovery window, no stage identification (health vs attach vs `session.create`), and no structured safe-recovery guidance. The only operator lever is `reload`, which kills the serve **without proving it idle**.

Top findings:

1. **The exact issue-3 boundary is `attachIfHealthy` + the leftover-lock guard**: `attachIfHealthy` requires a *strict* `ok` probe (`src/process.ts:183-196`); a slow serve fails it, and `attachOrSpawn` then throws `"did not answer in time. Not spawning another."` (`src/process.ts:291-296`) with no retry/recovery.
2. **Health has a small built-in retry (3 × 800 ms), `session.create` has a single 8 s timeout** — both unbounded-retry-free but with no recovery decision between them (`src/client.ts:223-247`, `src/client.ts:248-261`).
3. **`providerRecovery` notification machinery exists but only fires for mid-session stream loss**, never at startup (`src/bridge.ts:619-630`), and has no test coverage.
4. **`reload` (the "recycle" path) kills the serve unconditionally** — no idle proof (`src/process.ts:106-129`, `src/host-handlers.ts:38-50`), while the attach-only error message tells the operator to "recycle when idle" (`src/process.ts:298-302`). This is the gap the issue's "proven idle" criterion targets.
5. **Startup probe spawns a serve at BB startup** (`src/probe.ts:78-85`, marked `ponytail:`), so the locked serve in the issue may be an idle probe-spawned serve — relevant to any future idle-classification design.

Confidence: **HIGH** for the startup path and tests (all directly read); **MEDIUM** for BB-side behavior outside this repo (thread spawn → bridge `thread/start` wiring lives in the SDK).

---

## 2. Architecture Overview

```
BB app / CLI
   │  rpc (contract.ts rpcContract)          host rpc (contract.ts hostContract)
   ▼                                          ▼
server.ts (plugin entry)  ──host.call──▶  host.ts (host entry)
   │ probe/reload/listSessions…             │ handleProbe/handleReload/…
   │                                        ▼
   │                                   src/host-handlers.ts ──► src/probe.ts
   │                                            │                    │
   │                                            ▼                    ▼
   │                                      src/process.ts  ◄── attachOrSpawn (lock/claim/spawn)
   │                                            │
   ▼ (BB spawns thread; SDK invokes bridge over stdio JSON-RPC)
src/bridge.ts  (experimental_providerBridge, exported via host.ts:27)
   │  ensureClient() ──► deps.attach (= attachOrSpawn) ──► deps.acquire (= createSdkClient)
   │  thread/start → createSession → bindSession → threadIdentity notification
   ▼
src/client.ts (OpenCodeClient wrapper over @opencode-ai/sdk + raw fetch)
   │  health() / createSession() / promptAsync() … with timeouts
   ▼
Detached `opencode serve --port N --hostname 127.0.0.1` (spawned in src/process.ts:340-349)
```

- **Lock/claim files are host-wide**, not per-dataDir: `lockPath()` ignores its argument and returns `~/.bb/plugins/opencode/opencode.lock.json` (`src/process.ts:51-59`; test `tests/process.test.ts:164-167`).
- The bridge is a separate process from the plugin server: `host.ts:27` re-exports `experimental_providerBridge`; bridge state (`client`, `sessions`, `liveTurns`) is module-local (`src/bridge.ts:195-245`).

---

## 3. The Startup Path, End to End

### 3.1 Entry: BB thread start → bridge `thread/start`

- BB spawns a thread; the SDK delivers `thread/start` to the bridge handler (`src/bridge.ts:2389-2466`).
- First action inside the handler: `const active = await ensureClient();` (`src/bridge.ts:2403`).

### 3.2 `ensureClient` — attach + health + version gate (`src/bridge.ts:388-418`)

```ts
async function ensureClient(): Promise<OpenCodeClient> {
  if (client) {
    // Cheap liveness probe: the serve may have died and come back on a
    // different port (lock file updated); a cached client pointing at the
    // old URL never heals on its own. Drop it and re-attach from the lock.
    try {
      await client.health();
      return client;
    } catch {
      dropSubscriptions();
      client = undefined;
    }
  }
  ...
  const attached = await deps.attach(dataDir);
  client = deps.acquire(attached.url);
  const health = await client.health();
  if (!isVersionInWindow(health.version)) {
    throw new Error(versionSkewMessage(health.version));
  }
} catch (error) {
  client = undefined;
  throw new Error(publicErrorMessage(error));
}
```

- `deps.attach` defaults to `attachOrSpawn({ dataDir: dir })` (`src/bridge.ts:241`, reset path `src/bridge.ts:290`).
- `publicErrorMessage` maps abort-timeout errors to the generic `"OpenCode serve did not answer in time"` (`src/bridge.ts:381-386`) — **stage information is lost here**.
- Note: a cached client gets one `health()` (which itself retries 3×, §3.4) before re-attach; a fresh attach gets another `health()` after attach. Worst case ~2 health rounds before `session.create` is even attempted.

### 3.3 `attachOrSpawn` — the lock/claim/spawn state machine (`src/process.ts:281-406`)

Ordered behavior:

1. `reclaimIfStale` (`src/process.ts:171-181`): probes the locked port up to 3× (800 ms timeout each, 150 ms gaps). `"ok"` **or** `"slow"` → keep the lock. Only 3 consecutive `dead` probes remove it. Comment: *"Drop the lock only when the port is dead. A slow answer is not a missing serve."* (`src/process.ts:170`)
2. `attachIfHealthy` (`src/process.ts:183-196`): requires `portListening` === `"ok"` — **strictly** a healthy answer within 800 ms (`probePort`, `src/process.ts:151-160`). A slow-but-alive serve returns `undefined` here even though `reclaimIfStale` just preserved its lock.
3. **Leftover-lock guard** (`src/process.ts:291-296`) — the issue #3 failure point:

```ts
const leftoverLock = readLock(args.dataDir);
if (leftoverLock) {
  throw new Error(
    `OpenCode serve on :${leftoverLock.port} did not answer in time. Not spawning another.`,
  );
}
```

   No retry, no bounded wait, no recovery decision. This is the "preserves the live lock and refuses to spawn a duplicate, but startup fails" behavior named in the task.
4. Attach-only mode (`spawn === false`) throws `"OpenCode serve is not attached. Start a thread to spawn one, or recycle when idle."` (`src/process.ts:298-302`).
5. Spawn contention: a claim file (`opencode.lock.claim`, 5 s TTL, `src/process.ts:16`) is written with `flag: "wx"`; on contention the loser waits up to 80 × 100 ms = **8 s**, re-probing `attachIfHealthy` each cycle (`src/process.ts:317-322`), then throws `"Leftover OpenCode lock on :PORT. Attach or tell me to recycle; not spawning another."` (`src/process.ts:323-328`) or `"Timed out waiting for the other worker to publish the OpenCode lock"` (`src/process.ts:329-331`). **This 8 s bounded wait exists only for claim contention, not for a live-but-slow locked serve.**
6. Spawn path: allocate port, `spawn(binary, ["serve", "--port", …], { detached: true, … })` with stderr/stdout captured into an in-memory ring buffer (`src/process.ts:339-356`), wait up to 80 × 100 ms for health (`src/process.ts:357-366`), publish the lock (`src/process.ts:373-381`), and kill an unpublished child in `finally` (`src/process.ts:390-397`).

### 3.4 Health checking (`src/client.ts:223-247`)

```ts
async health() {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${url}/global/health`, {
        signal: AbortSignal.timeout(800),
      });
      if (!response.ok) throw new Error(`OpenCode health failed: ${response.status}`);
      return (await response.json()) as OpenCodeHealth;
    } catch (error) { last = error; if (attempt < 2) await delay(100); }
  }
  const detail = isAbortTimeout(last) ? "timed out" : ...;
  throw new Error(`OpenCode serve did not answer health (${detail})`);
}
```

- Bounded: 3 attempts × 800 ms + 2 × 100 ms gaps ≈ 2.6 s max. Distinguishes timeout vs HTTP-status vs connection error only inside the `detail` suffix.
- `probePort` in `src/process.ts:151-160` is a *separate*, non-retrying probe used for lock decisions; the two probes share the 800 ms timeout and `isAbortTimeout` classification (`src/process.ts:140-149`).

### 3.5 `session.create` (`src/client.ts:248-261`, `src/bridge.ts:2410-2416`)

```ts
const result = await withTimeout(
  sdk.session.create({ query: …, body: … }),
  OPENCODE_SETUP_MS,          // 8_000, src/client.ts:145
  "session.create",
);
```

- Single attempt, 8 s ceiling, error `"session.create timed out after 8000ms"` (`withTimeout`, `src/client.ts:150-169`). No retry, no recovery.
- A response with no id throws `"OpenCode session.create returned no session id"` via `requireSessionId` (`src/bridge.ts:750-753`, called at `src/bridge.ts:2415`).

### 3.6 Thread binding (`src/bridge.ts:755-775`, `src/bridge.ts:2417-2427`)

```ts
function bindSession(threadId: string, session: BoundSession): void {
  requireSessionId(session.sessionId, "bind");
  sessions.set(threadId, session);
  sessionToThread.set(session.sessionId, threadId);
  ...
  notify(BRIDGE_NOTIFICATION_METHODS.threadIdentity, {
    threadId,
    providerThreadId: session.sessionId,
  });
```

- Binding is in-memory (`sessions` / `sessionToThread` maps, `src/bridge.ts:195-196`) plus a `threadIdentity` notification to BB.
- Persistence on the BB side: `server.ts` recovers the session id from `thread/identity` events via `resolveSessionId` (`server.ts:945-962`) → `sessionIdFromThreadEvents` (`src/session-bind.ts:1-20`), used by every later RPC (revert, summarize, run chips, task children).
- After binding, `thread/start` answers `{ providerThreadId }` (`src/bridge.ts:2427`), then optionally hydrates (adopt) or runs the first prompt (`src/bridge.ts:2429-2456`). Failures after the answer become `failIssuedTurn` → `turn.boundary status:"failed"` deltas (`src/bridge.ts:491-512`, `2457-2464`).

### 3.7 Startup failure surfacing

- If `ensureClient` throws before the result is answered, `thread/start` responds with a JSON-RPC `BRIDGE_ERROR` carrying the raw message string (`src/bridge.ts:2457-2461`). There is **no error code, no stage field, no recovery-action field** — the contract for bridge errors is just `{ code, message }` (`respondError`, `src/bridge.ts:315-325`).
- The `providerRecovery` notification (`kind: "restartRecommended"`, `retryable: true`) exists but is emitted only from `serveLost` — i.e., after a mid-session SSE stream death where health also fails (`src/bridge.ts:619-630`, reached from `onStreamClosed` `src/bridge.ts:632-659`). Startup failures never emit it.

---

## 4. Existing Test Coverage (what regression tests can build on)

| Behavior | Test | Citation |
|---|---|---|
| Slow health keeps lock; `attachOrSpawn` refuses to spawn over it | `"keeps a lock when health is slow instead of spawning another serve"` — mocks `fetch` to throw `TimeoutError`, asserts `reclaimIfStale` → `false`, lock preserved, and `attachOrSpawn` rejects `/did not answer in time\|Not spawning another/`, `spawnMock` not called | `tests/process.test.ts:61-78` |
| Lock removed only when port is dead (3-strike probe) | `"removes a lock only when the port is not healthy"` | `tests/process.test.ts:80-95` |
| Dead-pid lock is stale | `"treats a dead pid as stale (ISC-50.1)"` | `tests/process.test.ts:55-59` |
| Claim-file TTL semantics | three tests: stale claim reclaimed, fresh claim kept, live-pid claim reclaimed after 5 s | `tests/process.test.ts:97-128` |
| Spawned serve exits during startup → error + child killed | `"kills a spawned serve that exits during startup"` | `tests/process.test.ts:130-154` |
| Attach-only refusal | `"refuses to spawn when attach-only and no healthy serve"` | `tests/process.test.ts:156-162` |
| Host-wide lock path | `"uses one host-wide lock path (ISC-50, ISC-62)"` | `tests/process.test.ts:164-167` |
| `reload` signals detached group, preserves a replacement lock | `"signals the detached process group and preserves a replacement lock"` | `tests/process.test.ts:177-211` |
| `reload` kills locked pid and removes lock (real child process) | `"kills the locked pid and removes the lock"` | `tests/process.test.ts:213-241` |
| Serve env strips Basic auth | `"does not inherit Basic-auth settings the bridge cannot answer"` | `tests/process.test.ts:35-45` |
| `session.create` returning no id → JSON-RPC error, no `thread/identity` | `"errors when session.create has no id instead of returning empty identity"` | `tests/bridge.test.ts:573-591` |
| SSE drop + healthy serve → live turns kept | `"keeps live turns when the event stream drops but serve is healthy"` | `tests/bridge.test.ts:2185-2207` |
| SSE drop + dead serve → live turns failed (ISC-26) | `"errors live turns when the event stream dies and serve is gone (ISC-26)"` — uses `fake.healthy = false` | `tests/bridge.test.ts:2209-2232` |
| First-turn setup failure after identity → `turn.boundary failed` | `"opens then fails the first turn if prompt setup dies after identity"` | `tests/bridge.test.ts:3471-3509` |
| Client cache keyed by URL | `tests/client-acquire.test.ts:8-25` | |
| Session-id recovery from `thread/identity` events | `tests/session-bind.test.ts:4-20` | |

**Test harness:** `tests/fake-opencode.ts` provides a full in-memory `OpenCodeClient` with a `healthy` flag (`tests/fake-opencode.ts:48,92-97`) and injectable `promptImpl`/`abortImpl` — the natural place to add deterministic slow-health / slow-`createSession` behavior. The bridge tests install it via `resetBridgeForTests({ acquire, attach, write })` (`tests/bridge.test.ts:62-72`); `attach` is stubbed there, so **bridge-level tests never exercise the real lock path** — that lives only in `tests/process.test.ts`.

**Note:** `vitest.config.ts` excludes `tests/provider-bridge.conformance.test.ts` from the default run (`vitest.config.ts:17-21`).

---

## 5. TODO / FIXME / Deliberate-Shortcut Evidence

- **No `TODO`/`FIXME`/`HACK`/`XXX` markers exist in source** (grep across `src/`, `server.ts`, `host.ts`, `contract.ts`, `tests/` returns only the unrelated `TODO_TOOLS` constant in `src/todos.ts:15`).
- `ponytail:` deliberate-simplification comments, the relevant ones:
  - `src/probe.ts:78-80` — *"probe now spawns an idle serve at bb startup so the needs-configuration badge doesn't stick on a transient 'not attached'. If a resident idle serve becomes a problem, gate behind a plugin setting."* Directly relevant: the locked serve in issue #3 may be this probe-spawned idle serve, and the comment anticipates the exact class of problem.
  - `src/bridge.ts:893`, `src/bridge.ts:2570`, `src/map-delta.ts:316,521,609`, `src/run-chip.ts:142` — unrelated to startup.
- Git history shows this area was hardened once for a *slower* variant of the same bug: commit `b5f9e96` *"fix: stop OpenCode start from aborting on a slow health ping"* introduced `probePort`'s ok/slow/dead triage, the 3-strike `reclaimIfStale`, health retry, and the leftover-lock no-spawn guard. Issue #3 is the residual case that commit deliberately did **not** solve: alive-but-slow *past* the guard, with no recovery path.

---

## 6. Confirmed Behavior vs Gaps

### Confirmed (cited)

| # | Behavior | Citation |
|---|---|---|
| C1 | Lock is host-wide, JSON, `{pid, port, startedAt, version?, cwd?}` | `src/process.ts:14,20-26,51-59` |
| C2 | `reclaimIfStale` keeps the lock on `ok` **or** `slow`; removes only after 3 dead probes | `src/process.ts:170-181` |
| C3 | `attachIfHealthy` requires strict `ok` within 800 ms | `src/process.ts:151-164,183-196` |
| C4 | Live lock + not-strictly-healthy port → immediate throw, no spawn, no retry | `src/process.ts:291-296` |
| C5 | Attach-only mode throws with "recycle when idle" guidance | `src/process.ts:298-302` |
| C3a | Claim contention has an 8 s bounded wait with re-attach probes (only for claim holders) | `src/process.ts:16-17,304-332` |
| C6 | `health()` retries 3× (800 ms each) then throws a stage-named message | `src/client.ts:223-247` |
| C7 | `session.create` = one attempt, 8 s `withTimeout`, label `"session.create"` | `src/client.ts:145,150-169,248-261` |
| C8 | `ensureClient` re-attaches when cached client fails health; wraps errors via `publicErrorMessage` which erases stage detail for timeouts | `src/bridge.ts:381-386,388-418` |
| C9 | Version-window gate (`1.18.0–<1.19.0`) inside `ensureClient` | `src/bridge.ts:405-408`; `src/identity.ts:4-5,9-19` |
| C10 | `thread/start` failure before answer → `BRIDGE_ERROR` with message only | `src/bridge.ts:2457-2461` |
| C11 | Binding = in-memory maps + `threadIdentity` notification; BB recovers session id from `thread/identity` events | `src/bridge.ts:195-196,755-775`; `server.ts:945-962`; `src/session-bind.ts:1-20` |
| C12 | `providerRecovery`/`restartRecommended` notification exists, fires only on mid-session serve loss | `src/bridge.ts:619-630,632-659` |
| C13 | `reload` = `stopServe` = SIGTERM group → wait 3 s → SIGKILL → remove owned lock; **no idle check** | `src/process.ts:105-129`; `src/host-handlers.ts:38-50`; `server.ts:233-237` |
| C14 | Startup probe spawns a serve (`spawn: true`) at BB startup | `src/probe.ts:78-85`; wired `host.ts:32-50`, `server.ts:204-232,644-661` |
| C15 | Duplicate-spawn safety is regression-tested | `tests/process.test.ts:61-78` |

### Gaps (what issue #3 asks for that does not exist today)

| # | Gap | Evidence of absence |
|---|---|---|
| G1 | **No bounded recovery attempt** for a live-but-slow locked serve. The only bounded wait (claim contention, C3a) does not apply; the leftover-lock guard throws on first pass. | `src/process.ts:288-296` — no loop between `attachIfHealthy` failure and the throw |
| G2 | **No stage-specific structured error.** All startup failures collapse to a message string; `publicErrorMessage` actively erases the timeout/abort distinction into a generic sentence. No `{ stage, elapsedMs, recoveryAction }` shape anywhere. | `src/bridge.ts:381-386,2457-2461`; `respondError` `src/bridge.ts:315-325`; contract has no such field (`contract.ts` bridge errors are SDK-defined) |
| G3 | **No safe-recovery guidance mechanism.** The error text says "recycle when idle" (`src/process.ts:300`) but `reload` performs no idle proof (C13) — the operator action the error recommends is exactly the unsafe one the issue forbids without proof. | `src/process.ts:298-302` vs `src/process.ts:105-129` |
| G4 | **No startup-path use of `providerRecovery`.** The notification exists (C12) but startup failures emit nothing; BB never receives a structured "restartRecommended" for a stalled serve at thread start. | Only call site is `serveLost` (`src/bridge.ts:625`) |
| G5 | **No test for persistent live-but-unresponsive at the bridge/startup level.** `tests/process.test.ts:61-78` covers the process-layer refusal; nothing tests repeated thread-start attempts against a locked unresponsive serve, elapsed-time bounds, or error shape. | Test inventory §4 |
| G6 | **No retry-once-after-recovery machinery for thread start.** `thread/start` is single-shot; there is no bounded "one recovery opportunity, then one retry" path. | `src/bridge.ts:2389-2466` |
| G7 | **Diagnostic logs are in-memory and unstructured** (80-line ring `src/debug-log.ts:1-27`; serve log 40 lines `src/process.ts:18,36-49`), exposed via `bb opencode logs` (`server.ts:757-760`). No stage/elapsed/recovery-decision records; also nothing that would leak prompts (prompts are never logged — `debugLog` calls log ids and 24-char text prefixes, e.g. `src/bridge.ts:372-377,1560-1565` — the 24-char prefixes are a privacy consideration for any new logging). | cited files |

---

## 7. Risks & Considerations for the Later Implementation

1. **Two health probes with different semantics.** `probePort` (process layer, ok/slow/dead) and `client.health()` (client layer, 3× retry, throws) must not be conflated; a recovery loop built on one will not be observed by the other. `src/process.ts:151-160` vs `src/client.ts:223-247`.
2. **`ensureClient`'s cached-client health check** (`src/bridge.ts:389-400`) means a recovery path must handle both "no client yet" and "cached client just failed health" — the latter already drops subscriptions and re-attaches.
3. **The lock is host-wide across all projects/hosts** (`src/process.ts:51-59`); any recovery wait serializes every BB worker on the machine. The existing claim-file TTL (5 s) and 8 s contention wait are the precedents for bounding it.
4. **`probe` spawns at startup** (C14): a "prove idle before recycle" design can likely use `session/status` (`runningSessionIdsFromStatus`, `src/session-status.ts:37-60`, used in `src/client.ts:553-567` and `src/host-handlers.ts:81-92`) as the idle evidence source — it is already the plugin's only running-session oracle.
5. **Error-message strings are load-bearing in tests**: `tests/process.test.ts:75` matches `/did not answer in time|Not spawning another/i`; changing wording breaks the regression net.
6. **Bridge tests stub `attach`** (`tests/bridge.test.ts:66`), so bridge-level recovery tests will need either a real `attachOrSpawn` integration or a new injectable failure mode in `deps.attach`.

---

## 8. Open Questions (unverified — outside this repo or not directly observable)

- How BB's SDK maps a `thread/start` JSON-RPC `BRIDGE_ERROR` to user-visible UI (does the message string surface verbatim?) — the SDK (`@get-bb/plugin-sdk` 0.4.16) is a node_modules dependency, not read here. **INSUFFICIENT EVIDENCE.**
- Whether `providerRecovery` (`kind: "restartRecommended"`) triggers any BB-side UI today — no consumer found in this repo; the SDK shim (`tests/shims/provider-bridge.ts`) only defines method-name constants.
- What actually made the real server unresponsive (issue itself says unknown; `issue.md:11`).
- Whether `AbortSignal.timeout(800)` under Node's fetch can produce non-`TimeoutError` abort shapes on all platforms — `isAbortTimeout` covers `TimeoutError`/`AbortError`/message regex (`src/process.ts:140-149`), but platform variance is unverified.

---

## 9. Recommended Investigation Anchors for the Implementation Stage

- Recovery loop insertion point: between `attachIfHealthy` failure and the leftover-lock throw, `src/process.ts:288-296` (or a wrapper in `ensureClient`, `src/bridge.ts:401-412`).
- Stage-tagged error shape: extend `publicErrorMessage` (`src/bridge.ts:381-386`) or introduce a structured error carried through `respondError` data (`src/bridge.ts:315-325`).
- Idle evidence: `/session/status` via `runningSessionIdsFromStatus` (`src/session-status.ts:37-60`).
- Deterministic repro: extend `tests/fake-opencode.ts` (`healthy` flag, `promptImpl` pattern) and the `globalThis.fetch` mock pattern from `tests/process.test.ts:61-78`.
- Regression anchors to preserve: `tests/process.test.ts:61-78` (no duplicate spawn), `tests/bridge.test.ts:573-591` (no-id error), `tests/bridge.test.ts:2209-2232` (ISC-26).

| Recap | |
|---|---|
| Before | Issue #3: live locked OpenCode serve blocks thread startup with no bounded recovery or stage-specific error. |
| Now | Full cited map of the attach/spawn/health/session.create/bind path, its tests, and 7 named gaps (G1–G7) separating confirmed safety behavior from missing recovery/diagnostics. |
| Next | Approach ranking can build directly on G1–G3 (bounded recovery, structured stage errors, idle-proven recycle). |
| Confidence | 🟢 ≥85% on all cited startup-path behavior and tests (directly read); 🟡 on BB SDK-side error surfacing (outside this repo, listed in Open Questions). |