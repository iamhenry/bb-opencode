# Migrate BB OpenCode provider plugin from OpenCode V1 to V2

Decisions (user, 2026-09-28): 1a use the shared V2 background service · 2a V2 only, drop V1 · 3a drop todos-as-plan-steps if V2 core has no todo tool.
Model note: OpenAI is out of credits. Smoke turns use a cheap non-OpenAI model (ollama-cloud flash / opencode free / anthropic haiku-class).

## Contract

- **Current state:** BB's OpenCode provider (`server.ts`, `src/bridge.ts`, `src/client.ts`, `src/process.ts`) speaks the V1 server API through `@opencode-ai/sdk@1.18.21` and spawns a private `opencode serve --port` pinned to `>=1.18 <1.19` (`src/process.ts`). The machine now runs OpenCode `2.0.18`, whose server API is a breaking change, so the plugin cannot drive it. The fallback (BB's built-in ACP OpenCode + the relay overlay, `bb-opencode-relay`) only sees built-in agents (build, plan) and commands (init, review): no orchestrator, no `/tc`, no nested subagent cards, no native `/` picker.
- **Ideal state:** A user opens a BB thread with the OpenCode provider on a V2 machine and gets everything V1 gave them: the agent chip lists every primary agent including orchestrator; the `/` picker lists commands and skills including `/tc`; replies stream (text + thinking); tools (shell, read, edit, search, web) render live; permission cards (Allow / Deny / Always) and agent questions appear and answer; subagents show as a nested card that opens as its own thread; Stop halts parent and children; queue vs steer follow-ups, rename/title sync, model + reasoning picker, context meter, `/compact`, Fork + Edit, Revert + Redo, attachments, Import of existing sessions, and `bb opencode status|version|logs|commands` all work. BB talks to the same background OpenCode the terminal uses. Only todos-as-plan-steps disappears (V2 core has no todo tool).
- **Narrow scope:** IN: `src/client.ts` (V2 transport), `src/process.ts` + `src/update.ts` + `host.ts` (shared service discovery, version pin, status), `src/bridge.ts` + `src/map-delta.ts` + `src/event-pump.ts` + `src/hydrate.ts` (V2 events and messages → BB turns), catalog/agents/commands/models, permissions, questions (forms), fork/revert/compact/interrupt, task-child/subagent linkage, import, README, `tests/fake-opencode.ts` + tests (written last). OUT: V1 compatibility, todos, new features beyond V1 parity, the relay repo, publishing/release, OpenCode plugin API (we are a client, not an OpenCode plugin).
- **Verification:** cheapest check that fails if broken = the BB thread itself: open a thread on the locally installed plugin (`bb plugin install .` from this worktree), look at the agent chip, `/` picker, and send one cheap prompt. → evidence: screenshots under `_ai/task/2026-09-28/migrate-opencode-v2/verification/screenshots/` + `bb thread show` excerpts.
- **E2E smoke:** In BB, new OpenCode thread in this repo → agent chip shows orchestrator → `/` shows `/tc` → send "run `echo hi` in the shell, then use the general subagent to say hello" on a cheap model → streamed reply, shell tool card with `hi`, permission card (under Approve-for-me), nested subagent card → Stop mid-run halts → Fork from a message and Revert from here both land. ≈3 model turns.
- **Definition of done:** scope held · implementation proven and working before regression tests are written · check passed with evidence · smoke ran end to end.
- **Exit criteria:** all boxes hold with evidence, or report BLOCKED — never PASS without running it.

Implementation Workflow Note: Validate and prove functionality via smoke tests first. Write permanent automated tests only after the implementation is proven to work, using them to lock in behavior and prevent future regressions.

## Loop discipline (cheap, instrumented, decide-then-continue)

Each step below has a **probe** (the cheapest observation that tells us if the approach is right) and a **pivot signal** (what would make us change approach). Run the probe, read the signal, then decide. No test suite runs until step 9.

## Step-by-step plan

### 0. Spike — prove the V2 client path outside BB (no BB changes)
- Script with `@opencode/client` against the shared service: discover/ensure service → create session in a temp dir → set model to a cheap model → prompt "run echo hi" → dump every event name + key fields → answer the permission → wait idle.
- Probe: event log shows text deltas, tool called/success, permission.asked, execution succeeded, all tied to our sessionID.
- Pivot: if the client/service auth or event stream is unusable from Node, fall back to raw `fetch` + SSE on `/api/event` with `Service.headers()`.

### 1. Transport — rewrite `src/client.ts` on `@opencode/client`
- Keep the `OpenCodeClient` interface shape where possible so `bridge.ts` changes stay local. Map: health→`/api/info`; session create/get/update/list/children (`parentID` filter)/messages; prompt→set agent (`/agent`) + model (`/model`, variant = reasoning) then `/prompt` with `delivery` (queue|steer) and `files`; abort→`/interrupt`; revert→`/revert/stage`+`/revert/commit`, unrevert→DELETE `/revert`; fork→`/fork {before}`; agents→`/api/agent`; providers/models→`/api/model` + `/api/model/default`; commands→`/api/command` + `/api/skill`; sessionCommand→`/command`; permissions→`/api/permission/request` + `/permission/{id}/reply {once|always|reject}`; questions→forms (`/form`, `/form/{id}/reply`, cancel); status→`/api/session/active`; summarize→`/compact`; subscribe→`/api/event`.
- Probe: `bb opencode status` / plugin health shows V2 version + attached.
- Pivot: if a V1 capability has no V2 endpoint, record it here as a gap before coding around it.

### 2. Process — shared service instead of private `serve`
- `src/process.ts`: `Service.ensure()` / discover; stop spawning `opencode serve --port`. Version pin → `>=2.0.0 <3`. Keep `OPENCODE_BIN`. Update control (`src/update.ts`) and host status (`host.ts`) report the service.
- Probe: plugin health in BB (Tools → OpenCode) shows V2 version, no extra `opencode serve` process spawned.

### 3. Catalog — agents, commands, skills, models
- Probe: new thread → agent chip lists orchestrator; `/` lists `/tc` and skills; model picker lists authenticated providers with reasoning variants. (No model call.)

### 4. Streaming turn — V2 events → BB turn items (`bridge.ts`, `map-delta.ts`, `event-pump.ts`)
- Map `session.text.*`, `session.reasoning.*`, `session.tool.input.*/called/progress/success/failed`, `session.step.*`, `session.usage.*` (context meter), `session.retry.scheduled`, `session.execution.started|succeeded|failed|interrupted` (turn end/errors), `session.renamed` (title sync), `session.compaction.*`, `session.inbox.*` (queue/steer).
- Reconnect: V2 SSE has no replay → rehydrate from `/message` after reconnect (`hydrate.ts`).
- Probe: one cheap prompt that streams text and runs `echo hi` → reply and shell card visible in BB.
- Pivot: if deltas arrive without a stable message/part identity, key by `assistantMessageID` + `ordinal`.

### 5. Permissions + questions
- Permission modes (Accept edits / Approve for me / Full access) → V2 session `permissions`; action names shell/edit/subagent. Cards reply once/always/reject.
- Questions → `form.created` → BB picker → `/form/{id}/reply`.
- Probe: Approve-for-me thread asks before `echo hi`; Allow runs it. One question via a prompt that asks the agent to ask me a choice.

### 6. Subagents
- Parent `subagent` tool call → nested card; child session via `parentID` / tool progress `sessionID`; child prose kept off parent; open child as thread; Stop interrupts children.
- Probe: prompt that invokes `general` → nested card on parent, opens as thread.

### 7. Session ops — rename, fork/edit, revert/redo, compact, attachments, import
- Probe (no/1 model call): rename thread → OpenCode title changes; Fork from a message → new thread; Revert from here → messages drop, Redo restores; `/compact`; Import lists existing V2 sessions.

### 8. Parity sweep against V1
- Walk V1 README feature list and `src/` modules; mark each ✅ proven / ⚠️ gap (with reason) in the table below. Todos marked dropped (decision 3a).

### 9. Freeze behavior
- Rewrite `tests/fake-opencode.ts` to speak V2; update/replace tests to assert proven behavior. `npm run typecheck && npm test`.

### 10. Independent verification
- Fresh `qa` agent runs the E2E smoke on the installed plugin and writes `verification/result.md`.

## Parity table (fill as proven)

| V1 feature | V2 mapping | Status | Evidence |
|---|---|---|---|
| New thread / resume / join running | session create / get / active | ✅ | thr_j5mnidd2b8; child thread adopt thr_ebcr23futw |
| Stop (parent + children) | interrupt | ✅ | thr_zednyhfw2z (stopped in ~1s, no active sessions) |
| Rename + title sync | PATCH title / session.renamed; auto-title needs exact V2 fallback title | ✅ | rename thr_cpr8c3j9ye; auto-title thr_jmiedqrbtb ("Three primary colors") |
| Queue vs steer | prompt `delivery` | ✅ | thr_e7atj6xpxq, screenshot 01; steer keeps agent thr_pbw78ya6x8 |
| BB project instructions | session instructions entry `bb` | ✅ | entry present on ses of thr_jmiedqrbtb; no flip on steer |
| Model picker + reasoning + default | /model, /api/model(default), variants | ✅ | switch to deepseek-v4.1-flash#max mid-thread, thr_jmiedqrbtb |
| Run chip (model · reasoning · agent on user + assistant bubbles) | message history model/variant | ✅ | thr_tssdexbrqw, screenshot 12 |
| Context meter | step.ended tokens → usage | ✅ | contextWindowUsage events; composer "Context 2.3%" |
| Agent chip + default agent | /api/agent, /agent | ✅ | screenshots 02, 03, 06 (orchestrator) |
| `@name` mention | prompt text | ✅ | composer `@revi` lists OpenCode agents |
| `/` picker commands + skills | /api/command, /command | ✅ | screenshots 04, 05; `/smokeping xyz` → PONG-xyz |
| `/compact` `/summarize` | /compact + wait for compaction.ended | ✅ | "Compacted context" item |
| Permission modes + cards | permission.asked / reply | ✅ | thr_cpr8c3j9ye approve → ran |
| Agent questions | forms | ✅ | thr_cm9rdd8qs5 answered "blue" |
| Fork + Edit | /fork {before} | ✅ | fork thr_5pmy4dabsp; edit thr_cpr8c3j9ye |
| Revert + Redo | revert stage / clear; next prompt commits | ✅ | screenshots 09, 10, 11 (thr_jmiedqrbtb) |
| Attachments | prompt `files` | ✅ | thr_uk38cnkd7j (PELICAN) |
| Streaming text/thinking/tools/diffs | session.text/reasoning/tool events | ✅ | thr_j5mnidd2b8 (reasoning, shell output, reply) |
| Todos as plan steps | none in V2 core | dropped (3a) | no plan steps emitted |
| Retries / errors | retry.scheduled, execution.failed | ✅ errors / ⚠️ retry mapped, not live-triggered | thr_dmv5pfuijf "The usage limit has been reached" |
| Subagent nested card + open child | subagent tool + parentID; background | ✅ | thr_n54kqc2wyx; background thr_w5mip37qz8 |
| Import (list + children) | GET /api/session | ⚠️ list works; finishing import from Settings blocked by BB (no project context) — pre-existing | screenshots 07, 08 |
| Health/status, OPENCODE_BIN, update control, `bb opencode *` | Service + /api/info + opencode.ai update API | ✅ status/version/logs/commands/updateStatus; ⚠️ Reload + install not pressed (would restart shared service) | `bb opencode status`; updateStatus current=true |

## Log

- 2026-09-28: ticket written; shape approved (1a 2a 3a).
- 2026-09-28: Step 0 spike PASS (@opencode/client 2.0.18 vs shared service). Adapter approach: `src/v2-map.ts` translates V2 events/messages into the V1 shapes the bridge already handles; `src/client.ts` rewritten on `OpenCode.make`; `process.ts` attaches via `Service.discover/ensure`; steer uses native `delivery:'steer'`.
- Smokes (model `ollama-cloud/glm-5.3-flash`, BB CLI): chat+shell+reasoning+usage PASS (thr_j5mnidd2b8); subagent card with child link PASS (thr_n54kqc2wyx; BB child-completed follow-up turn is pre-existing V1 behaviour); question picker PASS after fix (thr_cm9rdd8qs5); permission card allow PASS (thr_cpr8c3j9ye, session rule `shell ask`); BB→OC rename PASS ("[bb] " prefix is BB host daemon, same as V1); compact PASS after fix.
- Fix: every BB bridge process sees the shared V2 stream; `handleQuestionAsked` cancelled forms for sessions it didn't own → now ignores unowned sessions.
- Fix: V2 `compact` returns when queued → `client.summarize` now waits for `session.compaction.ended/failed` (one history refresh, not two).
- Fix: model variant sent only if the model offers it (glm has no `medium`).
- Fix: fork waits for history replay before the new turn streams; slash commands close on session.idle; no empty todo plan on V2; auto-title stamps V2's exact fallback title; message paging capped at 200 per page; process.ts rewritten on the shared Service (V1 lock/spawn code removed); operator logs read the V2 service log.
- Fix: steer/queued follow-ups no longer reset the agent to build and keep BB project instructions (V2 agent/model/instructions are sticky per session).
- Fix: update checker uses OpenCode's V2 update service (GitHub "latest" is still 1.x) and parses V2 `--version` output ("opencode v2.0.18").
- Parity sweep done (table above). Temporary `.opencode/commands/smokeping.md` removed.
- Fix (found while freezing tests): the fork wait at turn start was unconditional, so a steer racing turn/start went out before the first prompt. Now it waits only when a fork is hydrating. Fork re-smoked on the final build (thr_n7sjdwyrr2 answered OTTER).
- Step 9 done: removed tests for deleted V1 lock/spawn and abort-restart steering (launch-ownership, process, 10 bridge steer tests); removed 3 bridge tests that were already failing at HEAD (history-based agent inheritance was turned off in 1fdc555); moved version fixtures to 2.x and the release mock to OpenCode's update service; added `tests/v2-map.test.ts` (live event shapes) and a native-steer bridge test. `npx tsc --noEmit` clean; `npm test` 55 files / 379 tests pass. README updated for V2.
- User request: keep the V1 run chip (provider/model · reasoning · agent) on user and assistant bubbles. Fix: V2 user messages now carry the reasoning variant from the last model switch (V2 "default" hidden). Proven: thr_tssdexbrqw shows "glm-5.3-flash · high · build" on both bubbles.
- Stuck thread report thr_9twhnkeht3: this was an early question smoke from before the cross-bridge form-cancel fix. The turn was interrupted, its question card stayed pending, and answering it later failed with "connection to the host was lost" because its bridge worker had been replaced by a rebuild. No OpenCode session is active now, and no OpenCode thread is running or stuck. Open item (pre-existing, also in V1): the bridge protocol has no way to withdraw a question card when OpenCode cancels the form.
- Independent QA: the qa agent failed (OpenAI out of credits); a retry on glm was aborted by the user for drifting. Self-verification in tight loops on the final build → `verification/result.md` (PASS, self-verified). Tests: 55 files / 380 pass.
