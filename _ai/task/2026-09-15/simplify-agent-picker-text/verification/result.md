# Verification: Agent Picker — Drop "Agent" Label, Show Only Icon + Agent Name

## Verification Result

- Platform: `web`
- Objective: In the actual BB/OpenCode UI, the agent picker trigger renders `<icon> <agent-name>` with no "Agent" prefix, and the open dropdown still shows agent names + descriptions as before.
- Falsifier: The rendered trigger still shows the "Agent" prefix, or the dropdown rows lose names/descriptions/selection behavior.
- Primary flow: Load the exact candidate build in the real BB app with the OpenCode plugin active (`package.json:22` `app: "./app.tsx"`). Open a new-thread chat composer, locate the agent picker trigger, click it to open the dropdown, inspect trigger label and dropdown, select a different agent, confirm menu close + trigger update, reopen, capture screenshot.
- Regression check: Dropdown rows render `option.name` + `option.description`; selecting an agent closes the menu and updates the trigger name (`composer-agent.tsx:331-337`). Exercised: `build` → `plan` selection closed the menu, updated trigger to `plan`, and reopened cleanly.
- Mechanical: `npm run typecheck && npm run test` → exit 0; raw excerpt: `Test Files  56 passed (56)` / `Tests  410 passed (410)` / `Duration  13.69s` (vitest run, this worktree). `tsc --noEmit` produced no output (pass).
- Observable: `_ai/task/2026-09-15/simplify-agent-picker-text/verification/screenshots/agent-picker-trigger.png`
- Checks run:
  1. Candidate identity: worktree HEAD = baseline `c9fbe52f43956cbdc8df29d9f1ac17e0609e7e31` (branch `bb/simplify-agent-picker-text-thr_5xrxbn75re`), dirty files exactly `src/app/composer-agent.tsx` + `src/app/composer-agent.css` + untracked `_ai/`; `git diff --no-ext-diff` SHA-256 = `0c74955b75a0d380e8f8e90603f987916a14002e90c4edab96bc9ddad402cf6b`; diff is 10 deletions / 0 additions (prefix span + two `.oc-agent__prefix` CSS rules).
  2. Mechanical: `npm run typecheck && npm run test` rerun fresh on this candidate → exit 0, 56/56 files, 410/410 tests (includes `tests/shipped-imports.test.ts` 10/10).
  3. Runtime provenance: prior shared install pointed at the stale path source (`~/Desktop/Projects/other/bb-plugin-opencode`, clean tree at baseline `c9fbe52f`, `dist/app.js` still containing `oc-agent__prefix` / "Agent" span — would have failed the target). Reinstalled the plugin in the shared BB dev host from this worktree via `bb plugin install <worktree-path> --yes` (path source, same plugin id `opencode@0.1.1`, same install slot — no second plugin instance, no other plugins/services touched). `bb plugin source opencode` then resolved to this worktree path.
  4. Served-bundle identity: BB served app.js/css at `?h=fc44620a7dcbd3d1`, byte-identical (SHA-256 `e216804a58eea062a3b5283d9f794d4de95cf430319f3a47907cf39561c60ea2` / `bade4c1db1b9eaf7782a784995feb6dcebd4fe6a8d003c8beefea08b3923c83b`) to this worktree's `dist/app.js` / `dist/app.css` produced by the BB plugin build step during install; served bundles contain zero `oc-agent__prefix` occurrences.
  5. Live DOM (browser session `thr5xrxbn75re-verify`, viewport 1280×577, http://127.0.0.1:38886): trigger `[data-opencode-agent-picker]` text `build`, aria-label `OpenCode agent: build`; `document.querySelectorAll('.oc-agent__prefix').length === 0`; resource entry confirms the page loaded `http://127.0.0.1:38886/api/v1/plugins/opencode/assets/app.js?h=fc44620a7dcbd3d1` (the exact-candidate bundle).
  6. Dropdown open: `data-open="true"`; listbox "Primary agents" with 4 rows — `build` / `bb-supervisor` / `orchestrator` / `plan`, each with name + description; selected row `build`.
  7. Selection regression: clicked `plan` → menu closed (`data-open="false"`, no `.oc-agent-menu`), trigger text/aria-label updated to `plan`.
  8. Reopened picker: `data-open="true"`, selected row `plan`; captured the required screenshot (tightly cropped browser viewport containing the trigger and the open dropdown; raw viewport intermediate discarded, not retained).
  9. Closed menu via Escape and closed the browser session; no shared state left open.
- Verdict: `PASS`

### Evidence

- Screenshot: `_ai/task/2026-09-15/simplify-agent-picker-text/verification/screenshots/agent-picker-trigger.png` (620×338 crop of the browser viewport; shows trigger `🤖 plan` with no "Agent" prefix and the open "Primary agents" dropdown with name + description rows for build/bb-supervisor/orchestrator/plan, `plan` highlighted as selected)
- Report: `_ai/task/2026-09-15/simplify-agent-picker-text/verification/result.md` (this file)

### Notes

- Both acceptance criteria from issue.md:19-20 are proven on the rendered UI: trigger shows `<icon> <agent-name>` with no prefix, and dropdown names/descriptions render unchanged; selection close/update/reopen behavior confirmed.
- The initial shared install was stale (would have produced a false FAIL). The reinstall into the shared BB host was a mutation of shared service configuration, judged safe and proportionate: same plugin id/slot, reversible by reinstalling the previous path source (`~/Desktop/Projects/other/bb-plugin-opencode`), performed only because the target (actual BB UI on the exact candidate) was otherwise unreachable. The prior source directory was left untouched and can be restored with `bb plugin install /Users/macvm/Desktop/Projects/other/bb-plugin-opencode --yes` if desired.
- A trigger-only element screenshot was taken first, found insufficient (it could not show the dropdown), and was overwritten by the final trigger+dropdown crop. Only the final retained artifact remains.
- Raw snapshots, temp screenshots, and served-bundle copies were kept in OS temp and deleted; only the single retained screenshot and this report are durable.
- No code, test, plan, issue, package/lock/config, or pipeline files were edited. No commit, push, PR, or merge performed.
- Code quality gate: `APPROVE_CODE`, score 100, on this exact baseline + diff hash (input only; Mechanical was rerun independently here).

### Risk

- The screenshot is a tightly cropped browser-viewport region (trigger + dropdown area only), not the full window; it contains only app UI, no private desktop content.
- Compact/coarse-pointer banner layout (`CompactComposerAgentPicker`) was not separately exercised; the shared `AgentPicker` component and the deleted compact CSS rule are covered by the same diff and the expanded-layout proof.
- The plugin reinstall changed which path the shared BB host loads the `opencode` plugin from; this persists until another install/reload. No server, session, credential, or OpenCode runtime mutation occurred.

### Next Action

- Candidate is verified; hand off to commit owner for Phase 3 (commit after gates). Optionally restore the previous plugin source path if the shared host should keep pointing at `~/Desktop/Projects/other/bb-plugin-opencode`.