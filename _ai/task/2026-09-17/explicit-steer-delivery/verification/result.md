# Verification Result — Explicit OpenCode Steer Delivery

## Verification Result

- Platform: `non-ui`
- Assurance: `standard`
- Objective: An active-turn BB steer interrupts the obsolete OpenCode tool and the corrected output continues within the same BB turn; a genuine Stop during handoff yields exactly one interrupted boundary and no continued output.
- Falsifier: Obsolete output appears; correction becomes a later BB turn or vanishes; the active tool is not stopped; duplicate correction rows appear; a genuine Stop produces output or multiple terminal boundaries.
- Primary flow: Active `sleep 10` child (`thr_keayvufn29` / `ses_f4ee258c6ffeLlRSDzFU8s1u87`) receives a direct `bb thread tell --mode steer`; corrected output appears only in the same BB turn.
- Regression check: Genuine Stop immediately after an active steer (`thr_u4gwszjrd9` / `ses_f4ee18425ffepK6ZYWAqn20aZe`) produces exactly one `turn/completed status:interrupted` and no old or corrected output. Queue mode is covered mechanically by regression tests.
- Quality: `APPROVE_CODE` (fresh code-quality gate, score 94, Task `ses_f4ed4cb1dffe2r7XAwvNvzUclo`).
- Mechanical: `npx vitest run tests/bridge.test.ts` → 132/132 passed (fresh); `npm run typecheck` → exit 0 (fresh); `npm run build` → exit 0 (fresh; only the known SDK-pin notice `pins @get-bb/plugin-sdk 0.4.16; this bb's SDK is 0.4.99` and Node `DEP0205 module.register()` deprecation warning); `npm test` → 418 tests passed, 56 files (fresh); `git diff --check` → exit 0 (fresh). All freshly executed on the exact candidate worktree.
- Observable: retained BB thread transcripts (`bb thread log --json --all` for the three declared threads) plus authoritative OpenCode DB rows; report file `_ai/task/2026-09-17/explicit-steer-delivery/verification/result.md`.
- Checks run: BB event-log retrieval for all three threads; OpenCode `message`/`part` queries for all three sessions; plugin-load + setting provenance queries; mtime provenance; five fresh mechanical commands. No new threads spawned.
- Verdict: `PASS`

## Evidence

- BB transcript, primary steer (`thr_keayvufn29`, session `ses_f4ee258c6ffeLlRSDzFU8s1u87`), captured via `bb thread log --json --all`:
  - `client/turn/requested` (source `tell`, steer) at `1789677909723` (seq 12); `turn/input/accepted` at `1789677909803` (seq 13).
  - `sleep 10` tool started (BB item/started) at `1789677909060` (seq 11); OpenCode tool part state: start `1789677908951`, end `1789677909795` — stopped ~11 ms after correction persistence, never reaching the 10 s deadline; tool output contains `User aborted the command`.
  - OpenCode DB: correction user message `msg_0b11db716001WcUyT8PnjEjI7r` created `1789677909784` with exactly one correction text part `prt_0b11db716002RZor9Cp6eiE2B9` (`1789677909785`) — no duplicate correction rows.
  - Only corrected agent text: `PHASE_CHILD_STEERED` (text part start `1789677911866`, completed `1789677912112`), inside the same BB turn; exactly one `turn/completed status:completed` at `1789677912591` (seq 26). No `OLD_DINNER`/`PHASE_CHILD_OLD` output anywhere in the session.
- BB transcript, parent settlement/handoff (`thr_jiuvhqt6vu`, session `ses_f4ee43eb8ffeGLJgborcxERr33`): steer arrived at `1789677783971` (seq 8) before any obsolete tool started; only `PHASE_PARENT_STEERED` emitted; exactly one `turn/completed status:completed` at `1789677788069` for the steer turn. The later turn (seq 22+) is the system child-completed notification, not continued old output. Used for parent/handoff evidence only, as instructed (its correction preceded the obsolete tool start).
- BB transcript, genuine Stop regression (`thr_u4gwszjrd9`, session `ses_f4ee18425ffepK6ZYWAqn20aZe`): `sleep 10` active (started `1789677964253`); correction `client/turn/requested` at `1789677964778` (seq 10), persisted once in OpenCode DB as `msg_0b11e8e21001pxvyKHvXx9mW7y` with one part (`STOP_CORRECTED_OUTPUT` instruction text, which is the caller's correction, not assistant output); tool aborted (`User aborted the command`); `system/thread/interrupted reason:manual-stop` (seq 17) confirming an actual stop; exactly one `turn/completed status:interrupted` (seq 18); zero agentMessage items — no old and no corrected output.
- Candidate provenance: BB `plugins` row `opencode` enabled=1 with `root_dir`/`source_path` = `/Users/macvm/.bb/plugins/environment-git-worktree/host-data/worktrees/thr_65zc9458s4-1/bb-plugin-opencode` (this worktree); BB `app_settings_values` key `steerActiveThreadOnEnter` = `true`; `server.ts:92-112,176` wires the flag to `steerDelivery: "inject"`.
- Unchanged-production check: `src/bridge.ts` mtime `1789677485`, `src/client.ts` `1789672847`, `src/host-handlers.ts` `1789667693` — all predate the final live receipts (~`1789679648`); later edits are `tests/bridge.test.ts` (`1789678423`), `tests/fake-opencode.ts` (`1789672762`), and the ticket only, as declared. Diff contains no diagnostic logging, temp-file writes, or leftover instrumentation.
- Report: `_ai/task/2026-09-17/explicit-steer-delivery/verification/result.md`

## Notes

- Every declared ordering matches the independent reads exactly:
  - Primary: steer requested `1789677909723` → correction persisted once `1789677909784` (OpenCode DB) → tool ended `1789677909795` → corrected `PHASE_CHILD_STEERED` completed in the same BB turn → one `turn/completed status:completed`.
  - Parent: only `PHASE_PARENT_STEERED`, one completed boundary; correction arrived before the obsolete tool started, so it is used for handoff evidence only.
  - Stop: correction persisted once → tool aborted → `system/thread/interrupted reason:manual-stop` → exactly one `turn/completed status:interrupted`, no output of either kind.
- All falsifiers are disproven on the retained evidence: no obsolete output token (`OLD_DINNER`, `PHASE_CHILD_OLD`) in any of the three sessions; no correction deferred to a later BB turn; active tool stopped in both steer cases; one correction message + one part per session; genuine Stop yielded no output and a single interrupted boundary.
- All five mechanical receipts were freshly executed on the exact candidate (HEAD `9266b7871a843180b9ceb814dabd488efb0798d5` plus the current uncommitted diff) and match the declared results: 132/132 bridge tests, typecheck 0, build 0 with only the known SDK-pin and Node deprecation warnings, 418/418 full tests, `git diff --check` clean.
- Provenance independently established: plugin loaded from this exact worktree with `steerActiveThreadOnEnter=true`; production sources untouched after the live receipts; diff contains no leftover diagnostic instrumentation, secrets, or prompt-content logs.
- Why another probe was not warranted: both declared flows (primary and Stop) reached their terminal observations, all five mechanical receipts are fresh and green, and candidate identity is proven — further probes would add no decision-changing signal.

## Risk

- None within the declared target. Queue-mode steering is protected only by the mechanical regression suite (as declared), not by a fresh live run; production sources are unchanged since the live receipts, so this does not affect the verified claims.

## Next Action

- Commit (only when the user explicitly asks).