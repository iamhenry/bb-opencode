# External Signal Research — bb-plugin-opencode #3 (live-but-unresponsive server recovery)

**Versions verified:** `@opencode-ai/sdk` **1.18.21** (published 2026-08-21, npm registry) — matches `package.json`. OpenCode docs last updated Sep 3, 2026. Node.js docs v22.x LTS (repo devDep `@types/node ^22`). SDK source inspected from the published tarball (`dist/server.js`, `dist/client.js`, `dist/process.js`, `dist/gen/types.gen.d.ts`).

## Findings

**1. `GET /global/health` is the documented liveness probe — read-only, returns `{ healthy: true, version: string }`.**
- Source: https://opencode.ai/docs/server/ (Global APIs table) and https://opencode.ai/docs/sdk/ (Global section: "`global.health()` — Check server health and version — `{ healthy: true, version: string }`").
- Verified in installed SDK 1.18.21 types: `GlobalHealthResponses = { 200: { healthy: true; version: string } }` (`dist/v2/gen/types.gen.d.ts`).
- **What this changes:** health is a safe, side-effect-free probe suitable for bounded retry loops and stage diagnostics ("health probe failed after N ms"). It confirms the HTTP surface answers but **not** that the server is processing work — pair it with finding 2.

**2. `GET /session/status` is the documented way to see whether active work exists — per-session `idle | busy | retry` (retry includes `attempt`, `message`, `next`).**
- Source: https://opencode.ai/docs/server/ (Sessions: "`GET /session/status` — Get session status for all sessions — Returns `{ [sessionID: string]: SessionStatus }`").
- Verified in installed SDK types (`dist/gen/types.gen.d.ts`): `SessionStatus = { type: "idle" } | { type: "retry"; attempt: number; message: string; next: number } | { type: "busy" }`.
- **What this changes:** before any recovery action, `session.status` distinguishes "server alive but busy with real work" (must not kill/duplicate) from "alive and idle but wedged." A `retry` status with `attempt`/`next` is itself actionable diagnostic output the plugin can surface verbatim. This is the gate that makes "no duplicate server, no kill while active" enforceable rather than assumed.

**3. `POST /session` has no idempotency mechanism — a blind retry after an ambiguous timeout can create duplicate sessions.**
- Source: https://opencode.ai/docs/server/ (Sessions: "`POST /session` — Create a new session — body: `{ parentID?, title? }`"). No idempotency key/header is documented anywhere in the server API surface (full API table reviewed).
- **VERIFIED:** the endpoint exists with that body; **INFERRED:** because creation is a plain POST with no client-supplied idempotency token, re-issuing it after a timed-out-but-actually-succeeded request yields two sessions. The safe bounded-retry pattern is: attempt create → on timeout, re-probe via `session.list()`/`session.status` to detect whether the session already exists before retrying.
- **What this changes:** the recovery loop must be *probe-then-act*, never *blind-retry-POST*. Session creation is the one stage where a retry can duplicate BB work; health/status probes are the idempotent stages.

**4. The SDK's own server-start path kills the spawned process on timeout — do not use `createOpencode`/`createOpencodeServer` for recovery against the locked server; use `createOpencodeClient` (client-only, never spawns).**
- Source: https://opencode.ai/docs/sdk/ ("Create client" vs "Client only": *"If you already have a running instance of opencode, you can create a client instance to connect to it"* — `createOpencodeClient({ baseUrl })`).
- Verified in installed SDK source (`dist/server.js`): on start timeout it calls `stop(proc)` and rejects with `Timeout waiting for server to start after ${options.timeout}ms` (default `timeout: 5000`); `dist/process.js` `stop()` sends `proc.kill()` (taskkill /T /F on Windows). Also `dist/client.js` sets `req.timeout = false` on the custom fetch, disabling the generated client's default request timeout — meaning SDK client calls have **no built-in timeout**; the caller must supply `AbortSignal.timeout`.
- **What this changes:** recovery code must attach to the existing locked server via `createOpencodeClient` only. Any use of `createOpencode` during recovery risks spawning/killing a second server process — exactly the failure mode issue #3 forbids. And every SDK call needs an explicit per-attempt `signal` (finding 5) because the client defaults to unbounded waits.

**5. `AbortSignal.timeout(delay)` is the supported per-attempt bound (Node ≥17.3/16.14; repo targets Node 22); `AbortSignal.any(signals)` composes it with a cancellation signal, and the abort `reason` distinguishes timeout from external cancellation for stage diagnostics.**
- Source: https://nodejs.org/docs/latest-v22.x/api/globals.html — `AbortSignal.timeout(delay)`: *"Returns a new `AbortSignal` which will be aborted in `delay` milliseconds"* (added v17.3.0/v16.14.0); `AbortSignal.any(signals)`: *"aborted if any of the provided signals are aborted. Its `abortSignal.reason` will be set to whichever one of the `signals` caused it"* (added v20.3.0/v18.17.0); `abortSignal.reason` (v17.2.0) is retrievable for classification.
- **What this changes:** bounded retry = per-attempt `AbortSignal.any([AbortSignal.timeout(attemptMs), shutdownSignal])`. Inspecting `signal.reason` after failure lets diagnostics report *which stage* timed out and *how long it waited* (elapsed), without conflating user cancellation with unresponsiveness. The plugin already uses bare `AbortSignal.timeout(800)` for health (`src/client.ts:228`, `src/process.ts:154`) — composing with `any` is the upgrade path.

**6. OWASP Logging Cheat Sheet: log event-level facts, never sensitive data, and sanitize event content against log injection.**
- Source: https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html — *"Perform sanitization on all event data to prevent log injection attacks e.g. carriage return (CR), line feed (LF) and delimiter characters"*; never-log list includes *"Sensitive personal data"* and *"Commercially-sensitive information"*; operational use cases explicitly include *"Performance monitoring e.g. data load time, page timeouts"* and *"Providing information about problems and unusual conditions."*
- **What this changes:** recovery diagnostics should be structured fields (stage name, elapsed ms, HTTP status/error class, session-status type) — never raw server output tails, prompt content, or env/paths verbatim. If server stderr is captured for diagnostics, it must be sanitized (strip CR/LF/delimiters, truncate) before inclusion.

## What this changes about our approach (synthesis)

- **Attach, never spawn:** recovery uses `createOpencodeClient` against the locked server only; `createOpencode`/`createOpencodeServer` are off-limits in recovery paths because their timeout path kills the spawned process (SDK 1.18.21 `dist/server.js`).
- **Probe-then-act retry:** each bounded attempt is `health` → `session.status` → (only if idle) the mutating call. `session.status` showing `busy`/`retry` is a hard stop for any kill/duplicate action and doubles as user-facing diagnostic.
- **Bounded, classified waits:** per-attempt `AbortSignal.any([AbortSignal.timeout(ms), cancelSignal])` with a fixed attempt budget (no unbounded retry); `signal.reason` + stage label + elapsed time feed the structured failure diagnostic.
- **Session-create is the only duplication hazard:** after an ambiguous create timeout, re-check via `session.list()` before any re-POST (no idempotency key exists in the API).
- **Privacy-safe diagnostics:** structured stage/elapsed/status fields only; sanitized, truncated server output; no prompts, credentials, or raw env.

**Confidence:** 🟢 findings 1, 2, 4, 5, 6 VERIFIED against official docs and/or the exact installed SDK tarball. Finding 3's API surface is VERIFIED; the duplicate-session consequence is INFERRED (no idempotency mechanism documented anywhere in the official API reference). No version mismatch: SDK 1.18.21 matches `package.json`; docs current as of Sep 3, 2026.