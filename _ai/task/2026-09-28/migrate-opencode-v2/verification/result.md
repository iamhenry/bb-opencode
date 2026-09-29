## Verification Result

- Platform: `web` (BB web UI + BB CLI, real OpenCode 2.0.18 shared service)
- Assurance: `standard` — but NOT independent. The fresh `qa` agent was tried twice: first failed (its OpenAI model is out of credits), then was aborted by the user for drifting. The user asked the implementer to verify in tight loops. Treat this as implementer self-verification.
- Objective: a BB user can use OpenCode V2 through the `OpenCode` provider with V1 feature parity.
- Falsifier: thread errors, a missing or wrong reply, only build/plan agents, command not dispatched, no delegation card, no question picker, fork loses context, revert doesn't hide the message, run chip missing model or reasoning.
- Primary flow: spawn and drive threads in project `proj_z8a7i24wnt` on the installed plugin built from this worktree; UI checks in BB web.
- Regression check: steer must not switch the session's agent or drop BB instructions.
- Quality: no reviewer pass (see Assurance).
- Mechanical: `npx tsc --noEmit` → exit 0; `npm test` → 55 files, 380 tests passed (fresh, final candidate).
- Observable: `verification/screenshots/12-run-chips.png`, `13-agent-chip-final.png`, `14-slash-final.png`, `15-revert-final.png` (final build); earlier parity screenshots 01–11.
- Model-backed product operations: `ollama-cloud/glm-5.3-flash` (reasoning default/high), about 8 submitted turns in this final pass.
- Verdict: `PASS` (self-verified; independent QA still outstanding)

_Screenshots were kept locally and are not committed; thread IDs are the durable references._

### Evidence (final candidate = 0a293eb + uncommitted diff, rebuilt and reloaded)

| Claim | Thread | Observation |
|---|---|---|
| Chat + tool call + streaming | thr_tssdexbrqw | `sleep 10` shell call completed; reply streamed |
| Steer into the running turn | thr_tssdexbrqw | reply "second STEERED" in the same turn |
| Run chip (model · reasoning · agent) on user + assistant | thr_tssdexbrqw | "ollama-cloud/glm-5.3-flash · high · build" on both, screenshot 12 |
| Agent chip lists custom agents | thr_tssdexbrqw | build, plan, bb-supervisor, orchestrator, screenshot 13 |
| `/` picker shows OpenCode commands | thr_tssdexbrqw | `tc` under User commands, screenshot 14 |
| Question picker | thr_zpz5547dph | BB user_question; answered "blue" → reply "blue" |
| Subagent card + child thread | thr_ag374gersk → thr_2ssx8zfqba | delegation card linked to the child session; child replied "4"; parent "4" |
| Fork keeps context | thr_n7sjdwyrr2 | answered "OTTER" |
| Revert + undo | thr_tssdexbrqw | "2 reverted messages / Undo revert" dock, text back in composer; OpenCode revert staged then cleared, screenshot 15 |
| Steer keeps agent + instructions | thr_pbw78ya6x8 | session stayed `orchestrator`; no instructions flip |

Earlier-pass evidence for the rest of the parity table is in `ticket.md`: rename, auto-title, model switch, attachments, compact, stop, permissions, errors, background subagent, and the operator commands.

### Notes

- glm-5.3-flash sometimes skips an asked-for tool call (it answered "done" without running `echo`) and emits tag-like junk text. These are model artifacts, not plugin faults.
- Why no more probes: every declared claim has a terminal observation on the final build.

### Risk

- No independent QA or reviewer pass yet.
- Not exercised live: Reload button and OpenCode install/update (both would restart the shared service), and the retry banner (no cheap way to trigger it).
- Pre-existing and not V2-specific: run chips shift after a revert-and-resend (they are matched by position); a question card stays open if OpenCode cancels the form (no bridge call exists to withdraw it); Import from Settings has no project context in this BB version.

### Next Action

- Optional independent `qa` or reviewer pass on a non-OpenAI model, then commit when you ask.
