# Dependency Map — Startup Recovery for Live-but-Unresponsive OpenCode Server (Issue #3)

Target artifact: `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/research/dependency-map.md`
Scope: `attachOrSpawn`, health checks, session creation, thread/start, error serialization, host reload, tests. Read-only; every claim cited.

---

## 1. Executive Summary

Startup recovery for an OpenCode-backed BB thread flows through three layers: the **provider bridge** (`src/bridge.ts`, JSON-RPC over stdio), the **process/lock manager** (`src/process.ts`, file-lock + spawn), and the **host handlers** (`src/host-handlers.ts`, RPC-callable diagnostics/reload). A live-but-unresponsive server currently fails fast (~3–4s of probes) with a single generic error and **no bounded recovery window and no stage identification** — exactly the gap in issue #3.

Top findings:

1. **The "never spawn a second server" guard already exists and is tested** — `attachOrSpawn` throws when a leftover lock survives the stale-reclaim probes (`src/process.ts:291-296`), and `reclaimIfStale` treats a *slow* health answer as alive (`src/process.ts:170-181`). Any recovery design must reuse this, not bypass it.
2. **The only process-termination path is `handleReload` → `stopServe`** (`src/host-handlers.ts:38-50` → `src/process.ts:106-129`), exposed to the user as the "Reload OpenCode" settings button (`src/app/settings-section.tsx:40-52`). Recovery must not route through it unless the server is proven idle.
3. **`thread/start` answers the JSON-RPC result *before* running the prompt** (`src/bridge.ts:2425-2427` vs `2442-2456`), so error contracts differ by stage: pre-answer failures are `respondError` (BRIDGE_ERROR −32000), post-answer failures are `failIssuedTurn` → `turn.boundary failed` delta. A retry-after-recovery must respect this split or it will double-respond.
4. **`ensureClient` already re-attaches when a cached client's health fails** (`src/bridge.ts:388-418`) — this is the natural insertion point for bounded recovery, and it is where the "did not answer in time" error is serialized via `publicErrorMessage` (`src/bridge.ts:381-386`).
5. **The test shim omits `providerRecovery` from `BRIDGE_NOTIFICATION_METHODS`** (`tests/shims/provider-bridge.ts:18-20`), so `serveLost`'s recovery notification (`src/bridge.ts:625-629`) is currently untestable and would emit `method: undefined` under test. Any recovery work touching that path must extend the shim.

Confidence: **HIGH** for call graph, lock semantics, and error contracts (all directly cited). **MEDIUM** for BB-side consumption of `providerRecovery` (SDK-internal, not in this repo — see Open Questions).

---

## 2. Architecture Overview

```
 BB app (settings UI)          BB core (thread lifecycle)         BB host worker
      │ rpc "probe"/"reload"         │ thread/start (JSON-RPC)          │ host entry
      ▼                              ▼                                  ▼
 server.ts (rpcContract)     src/bridge.ts (provider bridge)      host.ts (handlers)
      │                            │ ensureClient()                    │
      │                            ▼                                   ▼
      │                     deps.attach = attachOrSpawn ◄──── src/host-handlers.ts
      │                            │                                   │   (11 call sites)
      │                            ▼                                   ▼
      │                     src/process.ts  ──── lock/claim files ──► src/probe.ts
      │                     (lock, spawn, health probes)                  (probe spawns too)
      │                            │
      │                            ▼
      │                     src/client.ts (OpenCodeClient wrap)
      │                            │  health() / createSession() / promptAsync() ...
      │                            ▼
      │                     detached `opencode serve` (child process, owns lock)
      │
      └── src/app/settings-section.tsx ── "Reload OpenCode" button
```

- **Bridge layer** (`src/bridge.ts`): JSON-RPC methods `initialize`, `provider/health`, `model/list`, `thread/start`, `thread/resume`, `thread/fork`, `turn/start`, `turn/steer`, `thread/stop`, `thread/name/set`, `skills/configure` (`src/bridge.ts:2255-2771`; method names in `tests/shims/provider-bridge.ts:3-16`).
- **Process layer** (`src/process.ts`): host-wide lock at `~/.bb/plugins/opencode/opencode.lock.json` (`src/process.ts:51-59`), claim file for spawn races (`src/process.ts:61-65, 304-332`), detached spawn (`src/process.ts:340-356`).
- **Host layer** (`host.ts` + `src/host-handlers.ts`): `probe`, `reload`, `logs`, `listSessions`, `sessionSnapshot`, `settleSession`, `revert`, `unrevert`, `revertState`, `listAgents`, `listCommands`, `summarize`, `listMessageMeta`, `stampPermissionMode` (`host.ts:31-133`; contract schemas `contract.ts:42-181`).
- **Client layer** (`src/client.ts`): SDK wrapper with per-call timeouts; `health()` has its own 3-attempt retry (`src/client.ts:223-247`).

---

## 3. Data Flow Analysis — Startup (thread/start) End to End

```
BB thread/start (JSON-RPC id)
  → bridge handlers[BRIDGE_REQUEST_METHODS.threadStart]      bridge.ts:2389
    → ensureClient()                                          bridge.ts:2403 → 388-418
        ├─ cached client? → client.health()  (3×800ms retry)  client.ts:223-247
        │    └─ fail → dropSubscriptions(); client=undefined  bridge.ts:396-399
        ├─ deps.attach(dataDir) = attachOrSpawn               bridge.ts:403, 241
        │    ├─ reclaimIfStale: 3× probePort(800ms) + 150ms   process.ts:171-181
        │    ├─ attachIfHealthy: 1× probePort                 process.ts:183-196
        │    ├─ leftover lock? → THROW "did not answer in time.
        │    │   Not spawning another."                       process.ts:291-296
        │    ├─ spawn===false? → THROW "not attached"         process.ts:298-302
        │    └─ claim → spawn detached → wait 80×100ms → writeLock  process.ts:304-389
        ├─ client.health() + version window check             bridge.ts:405-408
        └─ error → publicErrorMessage → THROW                 bridge.ts:409-412
    → active.createSession({directory})  (8s timeout)         bridge.ts:2411-2413; client.ts:248-261
    → createCount += 1                                        bridge.ts:2414
    → requireSessionId(created.id)                            bridge.ts:2415, 750-753
    → bindSession(threadId, bound)                            bridge.ts:2417-2425 → 755-775
    │    ├─ sessions.set + sessionToThread.set                bridge.ts:757-758
    │    ├─ notify thread/identity {threadId, providerThreadId}  bridge.ts:762-765
    │    └─ ensureSubscribed(client, cwd)  (SSE, per-dir dedup)  bridge.ts:769-774
    → emitDeltas session.reset                                bridge.ts:2426
    → respondResult {providerThreadId}   ◄── ANSWER BEFORE PROMPT   bridge.ts:2427
    → [adoptId? replayHydrate]  [bindOnly? finishBindOnlyStart]     bridge.ts:2429-2441
    → input.length>0 → runPrompt → promptAsync               bridge.ts:2442-2456; 3499-3508
```

**Failure serialization split** (`src/bridge.ts:2457-2464`):
- Before `respondResult`: `respondError(id, BRIDGE_ERROR, message)` — BB sees a JSON-RPC error for thread/start.
- After `respondResult`: `failIssuedTurn(threadId, message)` — BB sees a `turn.boundary status=failed` delta (`src/bridge.ts:491-512`).

**Live-but-unresponsive path today** (server alive, health slow):
1. `reclaimIfStale`: 3 probes, each times out at 800ms → classified `slow` → lock kept, returns `false` (`src/process.ts:174-178`). Worst case ≈ 2.85s.
2. `attachIfHealthy`: 1 probe → `slow` → returns `undefined` (`src/process.ts:188`).
3. `leftoverLock` present → throw `OpenCode serve on :PORT did not answer in time. Not spawning another.` (`src/process.ts:291-296`).
4. `ensureClient` catches → `publicErrorMessage`: if `isAbortTimeout`, message becomes `"OpenCode serve did not answer in time"` (`src/bridge.ts:381-386`; `isAbortTimeout` at `src/process.ts:140-149`).
5. `thread/start` → `respondError(BRIDGE_ERROR)`. **No retry, no stage label, no recovery guidance.** Total ≈ 3.7s.

A `session.create` timeout surfaces separately: `withTimeout(..., OPENCODE_SETUP_MS=8_000, "session.create")` (`src/client.ts:145, 248-259`) → error message `"session.create timed out after 8000ms"` (`src/client.ts:150-169`) — also unstage-labeled from the operator's perspective.

---

## 4. Dependency Map — Callers and Callees

### 4.1 `attachOrSpawn` (`src/process.ts:281-406`) — every caller

| Caller | File:Line | Cardinality | spawn flag | Failure behavior |
|---|---|---|---|---|
| Bridge default `deps.attach` | `src/bridge.ts:241` (also `290` test reset) | once per `ensureClient` miss; `ensureClient` called by 9 handlers (`bridge.ts:2283, 2346, 2403, 2481, 2520, 2684, 2719, 3110, 3399`) | spawn (default) | throws → `publicErrorMessage` |
| `handleListSessions` | `src/host-handlers.ts:64` | once per host RPC | `spawn: false` | catch → `{sessions: []}` |
| `handleListCommands` | `src/host-handlers.ts:123` | once per host RPC | spawn | throws to host caller |
| `handleListAgents` | `src/host-handlers.ts:138` | once per host RPC | spawn | throws |
| `handleSessionSnapshot` | `src/host-handlers.ts:155` | once per host RPC | spawn | throws |
| `handleSettleSession` | `src/host-handlers.ts:192` | once per host RPC | spawn | catch → `{ok:false,error}` |
| `handleRevert` | `src/host-handlers.ts:209` | once per host RPC | spawn | throws |
| `handleUnrevert` | `src/host-handlers.ts:230` | once per host RPC | spawn | throws |
| `handleRevertState` | `src/host-handlers.ts:238` | once per host RPC | spawn | throws |
| `handleListMessageMeta` | `src/host-handlers.ts:253` | once per host RPC | `spawn: false` | catch → `{messages: []}` |
| `handleSummarize` | `src/host-handlers.ts:274` | once per host RPC | spawn | throws |
| `probeOpenCode` | `src/probe.ts:81-85` | once per probe | `spawn: true` | catch → `ProbeResult.error` (`src/probe.ts:136-152`) |

**Blast-radius note:** probe *spawns a serve at BB startup* (`src/probe.ts:78-85`, with a `ponytail:` comment acknowledging the tradeoff). Any change to `attachOrSpawn`'s error/timeout contract changes the probe's `error` string, which is validated by `contract.ts:23-40` (zod `probeOutput`) and rendered in settings (`src/app/settings-section.tsx:84`).

### 4.2 Health-check producers/consumers

| Producer | File:Line | Consumers |
|---|---|---|
| `client.health()` — 3 attempts × 800ms, 100ms gaps, throws `OpenCode serve did not answer health (detail)` | `src/client.ts:223-247` | `ensureClient` cached-client probe (`bridge.ts:394`), post-attach check (`bridge.ts:405`), `provider/health` handler (`bridge.ts:2284`), `onStreamClosed` reconnect check (`bridge.ts:645`) |
| `probePort(port)` — 1× 800ms, returns `ok/slow/dead` | `src/process.ts:151-160` | `portListening` (`process.ts:162-164`), `reclaimIfStale` (`process.ts:171-181`), spawn wait loop (`process.ts:357-367`) |
| `attachIfHealthy` | `src/process.ts:183-196` | `attachOrSpawn` fast path (`process.ts:288`), claim-wait loop (`process.ts:320`), race re-check (`process.ts:335`) |
| Fake `health()` in tests | `tests/fake-opencode.ts:95-97` (returns `{healthy: fake.healthy, version: "1.18.21"}`) | all bridge tests via `installFake` (`tests/bridge.test.ts:62-72`) |

### 4.3 Session creation / thread binding

| Operation | File:Line | Once-only guarantees |
|---|---|---|
| `createSession` | `src/bridge.ts:2410-2416` | once per `thread/start` unless `options.adoptSessionId` set; `createCount` counter exported for tests (`bridge.ts:247-249`) |
| `bindSession` | `src/bridge.ts:755-775` | overwrites `sessions`/`sessionToThread` maps; emits `thread/identity` **every call** — a retry that re-binds re-notifies identity (idempotent for BB but observable) |
| `thread/resume` | `src/bridge.ts:2468-2505` | `getSession` first (validates), then bind, then `joinRunningSession` if running |
| `thread/fork` | `src/bridge.ts:2507-2545` | `forkSession` then bind then `replayHydrate` |
| Session-id recovery from BB events | `src/session-bind.ts:1-20`, used by `server.ts:945-962` | reads `thread/identity` events — the BB-side record of the binding |

### 4.4 Error serialization contract

| Path | Mechanism | File:Line |
|---|---|---|
| Timeout normalization | `isAbortTimeout` matches `TimeoutError`/`AbortError`/`aborted due to timeout` | `src/process.ts:140-149` |
| Public message | `publicErrorMessage` → `"OpenCode serve did not answer in time"` for timeouts, else `error.message` | `src/bridge.ts:381-386` |
| Pre-answer failure | `respondError(id, -32000 BRIDGE_ERROR, message)` | `src/bridge.ts:315-325, 2459-2461` |
| Post-answer failure | `failIssuedTurn` → `turn.boundary {status:"failed", error:{message}}` | `src/bridge.ts:491-512, 2463` |
| Serve-loss broadcast | `serveLost` → `failLiveTurns` + `notify(providerRecovery, {kind:"restartRecommended", retryable:true})` | `src/bridge.ts:619-630` |
| Session-level errors | `describeSessionError` → `{status, message}` (auth, abort, output-length…) | `src/session-status.ts:93-129`; used at `bridge.ts:1334, 1736` |
| Host RPC error shape | `{ok: boolean, error: string|null}` | `contract.ts:48-50, 86-89, 98-100` etc. |
| Probe error shape | `error: string|null`, `needsConfiguration: boolean` | `contract.ts:23-40`; `src/probe.ts:136-152` |

### 4.5 Host reload (the only kill path)

```
Settings button "Reload OpenCode"            src/app/settings-section.tsx:85-94
  → rpc.call("reload", {})                   settings-section.tsx:44
  → server.ts rpcContract.reload → host.call("reload")   (server.ts rpc layer)
  → host.ts handlers.reload                  host.ts:54-56
  → handleReload(dataDir)                    src/host-handlers.ts:38-50
  → stopServe(dataDir)                       src/process.ts:106-129
      ├─ SIGTERM to process group (-pid), 30×100ms wait, then SIGKILL
      └─ removeLockIfOwned — drops lock only if pid+port still match  process.ts:86-90
```

`stopServe` preserves a *replacement* lock written by a racing new serve (`tests/process.test.ts:177-211`). This is the operator's manual recovery action today; issue #3's "safe recovery action" guidance would point here.

### 4.6 Client caching

- Bridge: single module-level `client` keyed implicitly by last attach (`src/bridge.ts:216-217`), healed by the `ensureClient` health probe (`bridge.ts:388-400`).
- Host handlers: `Map<url, OpenCodeClient>` via `acquireClient` (`src/host-handlers.ts:24-28`; `src/client.ts:654-664`), keyed by URL, evicted only in tests (`host-handlers.ts:30-32`). A stale URL after a port change leaves a dead cached client in this map — the bridge heals itself, host handlers do not (they re-attach each call but `acquire` may return the stale cached client for the *old* URL only if the URL matches; a new attach URL creates a new entry, so this is safe in practice).

---

## 5. Public vs Internal APIs

**Public (exported, consumed across modules or by BB):**

| Symbol | File:Line | Consumers |
|---|---|---|
| `attachOrSpawn`, `readLock`, `stopServe`, `recentServeLog` | `src/process.ts:281, 67, 106, 38` | bridge, host-handlers, probe, tests |
| `reclaimIfStale`, `attachIfHealthy`, `portListening`, `isLockStale`, `pidAlive`, `isAbortTimeout`, `writeLock`, `removeLock`, `claimPath`, `lockPath`, `sharedLockDir`, `reclaimStaleClaim`, `openCodeServeEnvironment`, `resolveOpenCodeBinary` | `src/process.ts` (various) | tests + internal |
| `experimental_providerBridge` | `src/bridge.ts:3669-3677` | `host.ts:27` re-export → BB SDK |
| `handleLine`, `resetBridgeForTests`, `getCreateCount`, `ingestOpenCodeEvent`, `syncLiveTurnParts`, `syncSessionRevert`, `syncSessionTitle`, `hydrateBoundSession`, `recentUnknownLogLines` | `src/bridge.ts` (exports) | tests only |
| Host handlers `handleProbe`…`handleStampPermissionMode`, `currentLock`, `evictClientsForTests` | `src/host-handlers.ts` | `host.ts:10-25`, tests |
| `probeOpenCode`, `summarizeOpenCodeConfig` | `src/probe.ts:55, 37` | host-handlers, tests |
| `acquireClient`, `createSdkClient`, `OpenCodeClient` type | `src/client.ts:654, 666, 30` | bridge, host-handlers, fake |
| Host RPC contract (`probe`, `reload`, `logs`, …) | `contract.ts:42-181` | BB host protocol (zod-validated) |
| Plugin RPC contract (`threadProvider`, `probe`, `reload`, …) | `contract.ts:183-407` | app UI via `useRpc` (`src/app/settings-section.tsx:25`) |

**Internal (not exported):** `ensureClient`, `bindSession`, `runPrompt`, `failIssuedTurn`, `serveLost`, `onStreamClosed`, `settleIssuedTurn`, `publicErrorMessage`, `probePort`, `removeLockIfOwned`, `signalServe`, `allocatePort` — all reachable only through the exported surface above. Recovery logic added inside `ensureClient`/`attachOrSpawn` needs no new public API; a *stage-labeled error type* would be the one candidate new export.

---

## 6. Invocation Order and Cardinality Summary (startup, happy path)

1. `thread/start` → exactly 1 `ensureClient` (1 `attachOrSpawn` on cold start; 0 if cached client healthy).
2. Exactly 1 `createSession` (0 when `adoptSessionId` present — tested: `tests/bridge.test.ts:1084-1097`).
3. Exactly 1 `bindSession` → exactly 1 `thread/identity` notification.
4. Exactly 1 `respondResult` — **must remain exactly once**; a recovery retry that re-enters the handler would double-respond or double-create.
5. 0 or 1 `runPrompt` (only when `input.length > 0` and not bind-only).
6. SSE subscribe: at most 1 per directory (deduped by `subscriptions` map, `src/bridge.ts:661-674`).

**Duplicate-work hazards for a retry design:**
- `createCount`/`fake.calls.create` assertions exist (`tests/bridge.test.ts:869-884`) — a retry must not create a second session for the same thread.
- `bindSession` re-notification of `thread/identity` is observable by BB (`server.ts:954-958` reads these events); re-binding the *same* sessionId is benign, binding a *new* sessionId after partial work orphans the first.
- `respondResult` before `runPrompt` means a crash mid-`runPrompt` leaves BB holding a valid thread with a failed turn — the retry-once rule must apply to the *stage that failed*, not the whole handler.

---

## 7. Tests — Current Coverage and Affected Files

| Test file | What it pins | Lines of interest |
|---|---|---|
| `tests/process.test.ts` | slow-health keeps lock + refuses spawn (`/did not answer in time\|Not spawning another/i`, `spawnMock` not called); dead-port reclaim; claim TTL; spawn-exit cleanup; `spawn:false` refusal; host-wide lock path; `stopServe` group-kill + replacement-lock preservation | `61-78, 80-95, 97-128, 130-154, 156-162, 164-167, 170-241` |
| `tests/bridge.test.ts` | thread/start error when `session.create` returns no id; adopt without create; create-count stability during Task; stream-death behavior (healthy → keep turns; unhealthy → fail turns, ISC-26) | `573-591, 1084-1097, 861-884, 2185-2232` |
| `tests/probe-config.test.ts` | probe `needsConfiguration` on missing binary; probe spawn attempt surfaces `serve exited` error | `8-25, 27-56` |
| `tests/client-acquire.test.ts` | client cache keyed by URL, recreate after eviction | `8-25` |
| `tests/provider-bridge.conformance.test.ts` | canonical SDK protocol suite against fake (excluded from default vitest run, `vitest.config.ts:18-22`) | `16-50` |
| `tests/fake-opencode.ts` | the mock seam: `healthy` flag, `promptImpl`/`abortImpl` hooks, call counters | `3-49, 95-97, 140-160` |

**Tests that will need new cases per issue #3 acceptance criteria:** transient-slowness recovery (bounded), persistent live-but-unresponsive (stage-labeled error, no spawn, no kill), retry-at-most-once without duplicate `createSession`/`thread/identity`. The existing fake supports this: set `fake.healthy = false` and/or `fake.client.createSession` to a timeout-throwing stub (`tests/bridge.test.ts:2211, 575` show both patterns).

**Shim gap:** `tests/shims/provider-bridge.ts:18-20` defines only `threadIdentity` in `BRIDGE_NOTIFICATION_METHODS`; `bridge.ts:625` reads `.providerRecovery`, which is `undefined` under the shim. Any test asserting the recovery notification must add it to the shim first.

---

## 8. Risks and Considerations

1. **Process-ownership safety.** `stopServe` is the only sanctioned kill, and it already guards against killing a replacement serve (`removeLockIfOwned`, `src/process.ts:86-90`; test `tests/process.test.ts:177-211`). Any automatic recycling must satisfy a stronger "proven idle" predicate than `reclaimIfStale`'s "port dead" — e.g. `sessionIsRunning` across bound sessions — and must never run while `liveTurns` is non-empty. The bridge's in-memory turn state (`src/bridge.ts:195-197`) is per-bridge-process; *another* BB worker's active turns are invisible here, which is why the issue demands operator action for persistent stalls.
2. **Error-contract regression risk.** `attachOrSpawn`'s error strings are asserted verbatim in tests (`tests/process.test.ts:75`) and flow into the zod-validated probe output (`contract.ts:23-40`). Changing messages or adding structure must update both. `publicErrorMessage` (`src/bridge.ts:381-386`) collapses all timeouts to one string — stage information is lost exactly where issue #3 wants it preserved.
3. **Double-response risk.** `thread/start` answers before prompting (`src/bridge.ts:2427`). A naive "retry the handler" wrapper would call `respondResult` twice or mix `respondError` after `respondResult`. Retry must wrap only the `ensureClient`/`createSession` stage, before the answer.
4. **Duplicate BB work risk.** BB provisions thread + worktree before `thread/start` (issue context). A retry that creates a *second* OpenCode session after a partial first attempt leaves the first session orphaned but still bound in `sessionToThread` only if `bindSession` ran; if recovery happens between `createSession` and `bindSession`, the created session is fully orphaned (no BB record). Prefer reusing the created session id on retry, or creating only after recovery succeeds.
5. **Probe spawns at startup** (`src/probe.ts:78-85`). If recovery adds waiting, probe latency grows for every settings-page load; the existing `ponytail:` comment there shows the authors already treat probe spawn as a bounded tradeoff.
6. **Timing budget today.** Worst-case unresponsive path ≈ 2.85s (`reclaimIfStale`) + 0.8s (`attachIfHealthy`) + throw. `session.create` adds 8s (`OPENCODE_SETUP_MS`, `src/client.ts:145`). A bounded recovery window should be sized against these existing constants, not new unbounded ones.
7. **Host-handler fan-out.** 11 `attachOrSpawn` call sites in `host-handlers.ts` + 1 in `probe.ts` inherit any behavior change (longer waits, new error types). The `spawn:false` call sites (`host-handlers.ts:64, 253`) deliberately soft-fail; recovery logic must not make them block.

---

## 9. Recommended Approach (evidence-based, design-neutral)

- Insert bounded recovery in **`ensureClient`** (`src/bridge.ts:388-418`) — it is the single choke point for all 9 bridge handlers, already owns the health-probe-and-reattach loop, and already normalizes errors via `publicErrorMessage`. Host handlers keep their current fast-fail semantics.
- Reuse **`probePort`'s `ok/slow/dead` triage** (`src/process.ts:151-160`) as the recovery signal: `slow` = candidate for bounded wait; `dead` = existing `reclaimIfStale` path; `ok` but `session.create` timing out = the issue #3 core case, distinguishable by wrapping the `createSession` call site (`src/bridge.ts:2411`).
- Emit stage-labeled errors from `publicErrorMessage` (or a sibling) so `respondError` payloads carry `{stage, elapsed, guidance}` without breaking the string-message contract for older consumers.
- Retry-at-most-once belongs **inside the `thread/start` handler before `respondResult`** (`src/bridge.ts:2400-2427`), reusing an already-created session id if `createSession` succeeded but a later stage failed.
- Extend `tests/shims/provider-bridge.ts` with `providerRecovery` before asserting any recovery notification; add the four acceptance-criteria test cases to `tests/process.test.ts` (lock semantics) and `tests/bridge.test.ts` (thread/start stages) using the `fake.healthy` / `createSession` stub seams.

---

## 10. Open Questions (unverified — needs validation before implementation)

1. **How does BB core consume `providerRecovery` / `restartRecommended`?** The notification is emitted at `src/bridge.ts:625-629` but the method constant lives in `@get-bb/plugin-sdk/provider-bridge` (node_modules, not inspected here). Whether BB surfaces it as UI guidance or silently logs is **UNVERIFIED**.
2. **Does BB retry `thread/start` itself after a JSON-RPC error?** Not observable in this repo; the retry-once rule may need to be purely bridge-side. **UNVERIFIED.**
3. **What does `opencode serve` do to `/global/health` while a session is mid-model-call?** The `slow` classification (`src/process.ts:158`) is inferred from timeout behavior; whether a busy serve answers health quickly but stalls `session.create` is **UNVERIFIED** and determines whether health can serve as the "still alive" proof during recovery.
4. **`server.ts` reload RPC wiring** — `rpcContract.reload` exists (`contract.ts:192-195`) and the settings UI calls it (`settings-section.tsx:44`), but the exact `server.ts` handler line forwarding to `host.call("reload")` was not read in full; the probe path shows the pattern (`server.ts:204-224`). **INFERRED, low risk.**

---

| Recap | |
|---|---|
| Before | Startup recovery behavior was unmapped; issue #3 needed callers, call order, error contracts, and test seams for attachOrSpawn/health/session-create/thread-start/reload. |
| Now | Full cited dependency map delivered: 12 attachOrSpawn call sites, the ensureClient choke point, the pre/post-answer error split, the stopServe-only kill path, once-only guarantees (createSession, thread/identity, respondResult), and the test-shim providerRecovery gap. |
| Next | Owning gather-context stage serializes this report to `_ai/task/2026-09-03/live-unresponsive-opencode-recovery/research/dependency-map.md`; design phase should target ensureClient + pre-answer retry and validate the four open questions. |
| Confidence | 🟢 ≥85% on all cited call-graph, lock, and error-contract findings; 🟡 on BB-side providerRecovery consumption and serve behavior under load (Open Questions 1–3, node_modules/external not inspected). |