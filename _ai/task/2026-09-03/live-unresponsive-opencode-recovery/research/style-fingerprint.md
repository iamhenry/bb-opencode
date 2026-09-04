# Style Fingerprint — bb-plugin-opencode (for issue #3 startup recovery + deterministic tests)

## Module organization
- Flat `src/` directory, one concern per kebab-case file; no nested layers except `src/app/` (UI) and `src/permissions/` — `src/process.ts`, `src/client.ts`, `src/probe.ts`, `src/bridge.ts` are the startup-relevant files (`ls src/`).
- TypeScript ESM with explicit `.js` suffixes on local imports — `src/probe.ts:1-14` (`from "./identity.js"`, `from "./process.js"`).
- Small exported pure helpers colocated with their caller; interfaces exported for cross-file contracts — `src/process.ts:20-34` (`OpenCodeLock`, `AttachResult`).
- Entry points wired via `package.json` `bb` block: `server.ts`, `app.tsx`, `host.ts` — `package.json:20-22`.
- Host RPC handlers thin: `handleProbe` delegates straight to `probeOpenCode` — `src/host-handlers.ts:34-36`.

## Naming
- `camelCase` functions, `PascalCase` interfaces/types, `SCREAMING_SNAKE_CASE` module constants — `src/process.ts:14-18` (`LOCK_FILE_NAME`, `CLAIM_STALE_MS`).
- Duration constants end in `_MS` with numeric separators — `src/client.ts:145-148` (`OPENCODE_SETUP_MS = 8_000`, `OPENCODE_PROMPT_MS = 30_000`).
- Test helpers prefixed `with*` / `create*` / `reset*ForTests` — `tests/process.test.ts:23` (`withHome`), `tests/fake-opencode.ts:51` (`createFakeOpenCode`), `src/bridge.ts:251` (`resetBridgeForTests`).

## Error handling
- Canonical error-to-string idiom everywhere (24 occurrences): `error instanceof Error ? error.message : String(error)` — `src/probe.ts:147`, `src/bridge.ts:385`, `src/host-handlers.ts:47`.
- Best-effort paths swallow with a reason comment, never bare `catch {}` silently: `catch { /* config is diagnostic-only */ }` — `src/probe.ts:89-93`; `catch { /* children are best-effort; parent leftovers still apply */ }` — `src/bridge.ts:947-949`.
- Structured result objects carry stage-specific `error`/`authError`/`needsConfiguration` fields instead of throwing across the host boundary — `src/probe.ts:16-31` (`ProbeResult`).
- User-facing error mapping centralizes timeout classification: `publicErrorMessage` returns "OpenCode serve did not answer in time" for abort/timeout errors — `src/bridge.ts:381-386`; classifier `isAbortTimeout` checks `name === "TimeoutError" | "AbortError"` or `/aborted due to timeout/i` — `src/process.ts:140-149`.
- JSON-RPC errors use SDK error-code constants: `respondError(id, BRIDGE_JSON_RPC_ERRORS.BRIDGE_ERROR, error instanceof Error ? ...)` — `src/bridge.ts:2379-2385`.
- Guard-throw with actionable message, not silent fallback: `throw new Error(\`OpenCode serve on :${leftoverLock.port} did not answer in time. Not spawning another.\`)` — `src/process.ts:291-296`.

## Logging
- No `console.log`. Three ring-buffer sinks: `debugLog` (80 lines, `src/debug-log.ts:1-11`), `pushServeLog`/`recentServeLog` (40 lines, `src/process.ts:36-49`), `unknownLogLines` exposed via `recentUnknownLogLines()` — `src/bridge.ts:307-309`.
- Log lines are compact `key=value` pairs with `-` for absent: `debugLog(\`prompt ses=${id} dir=${directory || "-"}\`)` — `src/client.ts:309`; `history purpose=${purpose} ses=${sessionId} count=${messages.length} ... ms=${durationMs}` — `src/bridge.ts:472-474`.
- Metrics rate-limited by interval constant: `HISTORY_METRIC_INTERVAL_MS = 30_000` gate before logging — `src/bridge.ts:426, 464-475`.
- Host log endpoint merges sinks with prefixes: `serve ${line}` + event lines, sliced to limit — `src/host-handlers.ts:52-56`.

## Timing / boundedness (directly relevant to #3)
- Bounded retry loops with small `delay` sleeps, never unbounded: `for (let i = 0; i < 80; i += 1) { if (await portListening(port)) break; ... await delay(100); }` — `src/process.ts:357-366`; claim wait `CLAIM_WAIT_ATTEMPTS = 80` — `src/process.ts:17`.
- `delay` imported from `node:timers/promises` — `src/process.ts:12`.
- Fetch timeouts via `AbortSignal.timeout(ms)` — `src/process.ts:154` (800ms health probe), `src/client.ts:171-177` (`fetchTimed`).
- Promise-race timeout helper with label in message: `withTimeout(promise, ms, label)` rejects `\`${label} timed out after ${ms}ms\`` — `src/client.ts:150-169`.
- Health probe classifies three states `"ok" | "slow" | "dead"`; a slow answer is NOT treated as a missing serve — `src/process.ts:151-160, 170-181` (`probePort`, `reclaimIfStale` doc comment).
- Clock reads go through injectable `deps.now?.() ?? Date.now()` for testability — `src/bridge.ts:149, 458-461`.
- Deliberate ceilings marked with `ponytail:` comments naming the upgrade path — `src/probe.ts:78-80`.

## Mocking / test doubles
- Module mock with `vi.hoisted` for `node:child_process.spawn` — `tests/process.test.ts:6-7`.
- `globalThis.fetch` swapped per-test and restored in `afterEach` — `tests/process.test.ts:48-53`; fake fetch returning `{ ok: url.includes(":4242/") }` — `tests/process.test.ts:88-91`.
- Hand-rolled fake implementing the full `OpenCodeClient` interface with call counters (`fake.calls.prompt`, `fake.calls.abort`) and overridable impls (`fake.promptImpl`) — `tests/fake-opencode.ts:3-49, 140-156`.
- Dependency injection over module mocking for the bridge: `BridgeDeps { acquire, attach, write, now? }` — `src/bridge.ts:145-150`; tests install via `resetBridgeForTests({ acquire, attach, write })` — `tests/bridge.test.ts:62-72`.
- Env isolation helper `withHome` using `mkdtempSync(join(tmpdir(), "bb-oc-home-"))` with save/restore in `try/finally` — `tests/process.test.ts:23-33`; same pattern inline in `tests/probe-config.test.ts:29-54`.
- `vi.spyOn(process, "kill")` with `mockRestore()` in `finally` for pid-alive simulation — `tests/process.test.ts:187-209`.
- No `vi.useFakeTimers` anywhere in the repo (grep: zero hits); async settling uses `await vi.waitFor(...)` — `tests/event-pump.test.ts:46, 73, 81, 106` — or a tiny real `flush()` sleep (`setTimeout(resolve, 30)`) — `tests/bridge.test.ts:50-52`.

## Test structure
- One `tests/<file>.test.ts` per `src/<file>.ts`; colocated behavior names in `it()` titles, often with ISA criterion ids: `it("keeps a lock when health is slow instead of spawning another serve", ...)` — `tests/process.test.ts:61-78`; `it("interrupts and restarts turn/steer when BB steer-on-Enter is on (ISC-20)")` — `tests/bridge.test.ts:74`.
- `describe` blocks group by feature area (`"lock reclaim"`, `"stopServe"`, `"provider bridge"`), flat `it()`s inside — `tests/process.test.ts:47, 170`.
- Assertions on thrown messages use regex `rejects.toThrow(/did not answer in time|Not spawning another/i)` — `tests/process.test.ts:73-75`.
- Negative assertions prove safety: `expect(spawnMock).not.toHaveBeenCalled()` — `tests/process.test.ts:76`.
- State reset via `afterEach(() => resetBridgeForTests())` — `tests/bridge.test.ts:57-60`.
- Vitest config: `environment: "node"`, include `tests/**/*.test.ts` + `src/**/*.test.ts`, SDK shim alias `@get-bb/plugin-sdk/provider-bridge` → `tests/shims/provider-bridge.ts` — `vitest.config.ts:9-24`.

## Tooling commands
- `npm run typecheck` → `tsc --noEmit`; `npm test` → `vitest run --config vitest.config.ts`; `npm run build` → `bb plugin build` — `package.json:25-29`.
- tsconfig: `strict: true`, `target: ES2022`, `moduleResolution: "bundler"`, `noEmit` — `tsconfig.json:2-11`.
- No ESLint/Prettier config in repo; formatting is enforced only by convention (2-space indent, double quotes, trailing commas).

## Commit style
- Conventional Commits with scopes, small focused diffs: `fix(provider): exit bridge workers after signals`, `fix: spawn opencode serve from startup probe`, `feat(settings): add Reload OpenCode button` — `git log --oneline -15`.
- Scope vocabulary: `provider`, `bridge`, `composer`, `tasks`, `prompt`, `settings`, `readme`.

## Adjacent precedent for issue #3 (reuse, don't reinvent)
- The exact failure mode already has a test: slow health ⇒ keep lock, refuse spawn — `tests/process.test.ts:61-78` asserts `reclaimIfStale` returns false and `attachOrSpawn` rejects with `/did not answer in time|Not spawning another/i`.
- `reclaimIfStale` already implements the "dead vs slow" bounded probe (3 attempts, 150ms apart) — `src/process.ts:171-181`.
- `ensureClient` already re-checks `client.health()` and re-attaches from the lock when the cached client is stale — `src/bridge.ts:388-418`.
- Stage-distinguishing structured results already exist in `ProbeResult` (`error`, `authError`, `needsConfiguration`, `serveLog`) — `src/probe.ts:16-31`; a recovery error should follow this shape, not invent a new one.
- `serveLost` emits a structured `providerRecovery` notification (`kind: "restartRecommended"`, `retryable: true`) — `src/bridge.ts:619-630`; candidate pattern for "safe recovery action" messaging.

## Open questions (unverified)
- Whether `server.ts` calls `attachOrSpawn`/`probeOpenCode` directly at startup — grep found no direct references in `server.ts`; the startup path appears to route through `host-handlers.ts` → `probeOpenCode`, but the full `server.ts` wiring (1036+ lines) was not read end-to-end.
- Whether BB SDK exposes a thread-start retry hook the fix should use instead of plugin-local retry — no evidence found in the files inspected.