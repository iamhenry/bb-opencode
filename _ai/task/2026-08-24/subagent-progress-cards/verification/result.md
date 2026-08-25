## Verification Result

- Platform: `web`
- Objective: prove a user can watch native child tool activity inside a running OpenCode Task card and see its final Output after completion.
- Primary flow: spawn a real BB OpenCode thread, launch one general subagent, observe its live tool rows, wait for completion, and expand the Task Output.
- Regression check: child prose stays out of nested activity; Task output appears once inside the Task card.
- Verdict: `PASS`

### Evidence

- Running state: `running-subagent-fixed.png` shows `Running subagent: Task` with nested `Ran tool glob` and `Read` activity.
- Completed state: `completed-subagent-fixed.png` shows collapsed activity summary and the final Task output.
- Targeted bridge test: 66/66 passed.
- Full test suite: 44 files, 244/244 tests passed.
- TypeScript: `npm run typecheck` passed.
- Plugin package: `npm run build` passed and emitted server/app/host bundles.
- Diff hygiene: `git diff --check` passed.

### Notes

- Mechanical observation first exposed an orphaned-row bug: Task cards keyed by `callID`, while child `parentRef` preferred `id`.
- `rememberTaskChild` now uses the same `callID ?? id` preference as Task mapping; the strengthened test uses distinct identifiers.
- Code quality gate: `APPROVE_CODE`, 97/100.
- Build reported an existing SDK patch-version notice: plugin pins 0.4.14 while local BB provides 0.4.15; build still succeeded.
- BB native delegation remains the frontend; no custom chat component, RPC, polling, or dependency was added.

### Next Action

- Review and commit the scoped feature files when desired.
